// ====================================================================
// content.js — CSS fingerprinting detector (값 에코 기반 확인 포함) - fixed
// - Sources (Source):
//   · @media: 사용자/OS 선호(prefers-*)·입력능력(pointer/hover)·디스플레이(capability)·앱 환경(display-mode 등)
//   · @supports: 엔진/버전 특성이 드러나는 일부 기능 (:has, backdrop-filter, timeline 계열 등)
//   · @font-face: local(...) 사용 시(로컬 폰트 존재 여부 탐지)
//   · @import: 위의 @media 조건이 걸린 경우만 소스로 간주 (+ geometry 옵션)
// - 조건부 소스(낮은 신뢰도): 지오메트리(width/height/aspect-ratio/orientation), @container(inline-size/block-size/style())
//   → 단, 싱크(URL) 안에 해당 조건에서 뽑은 토큰(값/키워드 등)이 그대로 에코될 때만 실제 소스로 인정
// - 싱크(Sink): 실제 네트워크 호출이 있는 경우만(url(...), @import url(...)/"...")
// - 소스-싱크 연결: 같은 규칙 + 조상 그룹(ancestor group)까지 인정
// ====================================================================

if (!window.__cssLoggerInjected) {
  window.__cssLoggerInjected = true;

  const MAX_RULES_PER_SHEET = 1500;
  const MAX_TOTAL_RULES = 8000;
  const URL_SNIPPET_LEN = 1600;

  // ---------------- 도우미 ----------------
  const short = (s, n = 240) => (s && s.length > n ? s.slice(0, n) + "..." : (s || ""));
  const lower = (s) => (s || "").toLowerCase();

  const MIN_TOKEN_LEN = 3; // ignore alpha tokens shorter than this unless numeric-prefixed (e.g., 2dppx)
  const TOKEN_BOUNDARY = /\b/;

  function isUsefulToken(tok) {
    if (!tok) return false;
    tok = String(tok).trim();
    if (!tok) return false;
    // numeric or unit-like tokens are allowed
    if (/^\d/.test(tok)) return true;
    // short alphabetic tokens are noisy
    if (tok.length < MIN_TOKEN_LEN) return false;
    return true;
  }

  function getRuleTypeNameByNumber(t) {
    const map = {};
    if (typeof CSSRule !== "undefined") {
      map[CSSRule.STYLE_RULE] = "CSSStyleRule";
      map[CSSRule.IMPORT_RULE] = "CSSImportRule";
      map[CSSRule.MEDIA_RULE] = "CSSMediaRule";
      map[CSSRule.FONT_FACE_RULE] = "CSSFontFaceRule";
      map[CSSRule.SUPPORTS_RULE] = "CSSSupportsRule";
      map[CSSRule.PAGE_RULE] = "CSSPageRule";
      map[CSSRule.KEYFRAMES_RULE] = "CSSKeyframesRule";
    }
    return map[t] || "CSSRule";
  }
  function ruleTypeName(rule) {
    try {
      if (typeof rule.type === "number") {
        const name = getRuleTypeNameByNumber(rule.type);
        if (name !== "CSSRule") return name;
      }
      return (rule.constructor && rule.constructor.name) || "CSSRule";
    } catch { return "CSSRule"; }
  }
  function getConditionText(rule) {
    try {
      if (rule.conditionText) return rule.conditionText;                   // @media/@supports/@container
      if (rule.media && rule.media.mediaText) return rule.media.mediaText; // CSSImportRule media
    } catch {}
    return "";
  }

  function extractUrlStrings(text) {
    const urls = [];
    if (!text) return urls;
    const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/ig;
    let m;
    while ((m = urlRegex.exec(text)) !== null) urls.push(m[1]);
    return urls;
  }
  function extractImportUrls(text) {
    const urls = [];
    if (!text) return urls;
    const importRegex = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/ig;
    let m;
    while ((m = importRegex.exec(text)) !== null) urls.push(m[1] || m[2]);
    return urls;
  }

  // ---------------- 소스 키 사전 ----------------
  const MEDIA_SOURCES = [
    // 사용자/OS 선호
    { key: "prefers-color-scheme",   group: "user preference",   claim: "color scheme (light/dark)" },
    { key: "forced-colors",          group: "user preference",   claim: "forced colors (OS high contrast)" },
    { key: "prefers-reduced-motion", group: "user preference",   claim: "reduced motion preference" },
    { key: "prefers-contrast",       group: "user preference",   claim: "contrast preference" },
    { key: "prefers-reduced-data",   group: "user preference",   claim: "reduced data preference" },
    { key: "prefers-reduced-transparency", group: "user preference",   claim: "reduced transparency preference" },
    { key: "inverted-colors",              group: "user preference",   claim: "inverted colors (OS color inversion)" },

    // 입력 능력
    { key: "pointer",      group: "input capability",            claim: "pointer accuracy" },
    { key: "any-pointer",  group: "input capability",            claim: "any-pointer accuracy" },
    { key: "hover",        group: "input capability",            claim: "hover capability" },
    { key: "any-hover",    group: "input capability",            claim: "any-hover capability" },

    // 디스플레이 특성
    { key: "color-gamut",   group: "display capability",         claim: "color gamut" },
    { key: "dynamic-range", group: "display capability",         claim: "HDR dynamic range" },
    { key: "monochrome",    group: "display capability",         claim: "monochrome bit depth" },
    { key: "resolution",    group: "display capability",         claim: "pixel density (dpi/dppx)" },
    { key: "device-pixel-ratio", group: "display capability",    claim: "device pixel ratio (alias)" },

    // 앱/환경
    { key: "display-mode",         group: "app environment",     claim: "PWA display mode" },
    { key: "environment-blending", group: "app environment",     claim: "environment blending mode" }
  ];

  const MEDIA_SOURCES_GEOMETRY = [
    { key: "width",         group: "geometry", claim: "viewport width" },
    { key: "height",        group: "geometry", claim: "viewport height" },
    { key: "aspect-ratio",  group: "geometry", claim: "viewport aspect ratio" },
    { key: "orientation",   group: "geometry", claim: "screen orientation" },
    { key: "device-width",  group: "geometry", claim: "device width (deprecated)" },
    { key: "device-height", group: "geometry", claim: "device height (deprecated)" }
  ];

  const SUPPORTS_SOURCES = [
    { key: "accent-color",        group: "engine feature",       claim: "accent-color support" },
    { key: "text-wrap: balance",  group: "layout capability",    claim: "text-wrap balance support" },
    { key: "contain:",            group: "layout capability",    claim: "contain property support" },

    { key: "selector(:has",      group: "selector capability",  claim: ":has() selector support" },
    { key: "backdrop-filter",    group: "graphics pipeline",    claim: "backdrop-filter support" },
    { key: "anchor-name",        group: "layout capability",    claim: "anchor positioning support" },
    { key: "view-timeline",      group: "timeline capability",  claim: "view timeline support" },
    { key: "animation-timeline", group: "timeline capability",  claim: "animation timeline support" },
    { key: "timeline-scope",     group: "timeline capability",  claim: "timeline scope support" },
    { key: "font-variation-settings", group: "font capability", claim: "variable font support" },
    { key: "color(display-p3",   group: "color capability",     claim: "display-p3 color function support" },
    { key: "scrollbar-gutter",   group: "engine feature",       claim: "scrollbar-gutter support" },
    { key: "scrollbar-width",    group: "engine feature",       claim: "scrollbar-width support" },
    { key: "scrollbar-color",    group: "engine feature",       claim: "scrollbar-color support" },
    { key: "-webkit-appearance", group: "engine hint",          claim: "WebKit-specific appearance" },
    { key: "-moz-appearance",    group: "engine hint",          claim: "Gecko-specific appearance" }
  ];

  const CONTAINER_SOURCES = [
    { key: "inline-size", group: "container query", claim: "container inline-size" },
    { key: "block-size",  group: "container query", claim: "container block-size" },
    { key: "style(",      group: "container query", claim: "container style() query" }
  ];

  const FONT_LOCAL_TOKEN = "local(";
  const IMPORT_MEDIA_KEYS = MEDIA_SOURCES.map(m => m.key)
    .concat(MEDIA_SOURCES_GEOMETRY.map(m => m.key)); // include geometry as optional low-trust import gate

  // ---------------- 리스크 점수 ----------------
  function riskFor(group) {
    switch (group) {
      case "fonts":                return 4;
      case "user preference":      return 3;
      case "display capability":   return 3;
      case "input capability":     return 2;
      case "selector capability":  return 2;
      case "graphics pipeline":    return 2;
      case "timeline capability":  return 2;
      case "layout capability":    return 2;
      case "font capability":      return 2;
      case "color capability":     return 2;
      case "engine feature":       return 1;
      case "engine hint":          return 1;
      case "app environment":      return 1;
      case "geometry":             return 1;
      case "container query":      return 1;
      case "font coverage":        return 1;
      default:                     return 1;
    }
  }

  function explanationFor(group, keyword, claim) {
    switch (group) {
      case "fonts":
        return "Local font presence reveals installed fonts and can strongly identify a device.";
      case "user preference":
        return "Reveals OS/user accessibility or UI preferences.";
      case "display capability":
        return "Reveals screen/output characteristics (gamut, HDR, pixel density).";
      case "input capability":
        return "Reveals input device capability (touch vs mouse) and pointer precision.";
      case "selector capability":
      case "graphics pipeline":
      case "timeline capability":
      case "layout capability":
      case "font capability":
      case "color capability":
        return "Reveals browser engine/version capability.";
      case "engine feature":
      case "engine hint":
        return "Hints at browser engine family.";
      case "geometry":
        return "Reflects viewport/window state; low entropy unless the condition value is exfiltrated.";
      case "container query":
        return "Reflects layout container size; low entropy unless the condition value is exfiltrated.";
      default:
        return `Reveals ${claim || keyword || group}`;
    }
  }

  // ---------------- 토큰 추출 ----------------
  // Enhanced: capture feature:value pairs and identifiers inside parentheses
  function tokensFromMediaCondition(cond) {
    const t = new Set();
    if (!cond) return [];

    const c = lower(cond);

    // (feature: value) pairs - pull both feature and value idents
    for (const m of c.matchAll(/\(\s*([-\w]+)\s*:\s*([^)]+?)\s*\)/g)) {
      const feature = (m[1] || "").trim();
      const value = (m[2] || "").trim();
      if (isUsefulToken(feature)) t.add(feature);

      // split the value into idents and numeric units
      const parts = value.split(/[\s/,+]+/);
      for (let part of parts) {
        part = part.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(part)) t.add(part);
      }
    }

    // numeric + unit combos
    for (const m of c.matchAll(/(-?\d+(?:\.\d+)?)(\s*)(px|dppx|dpi|dpcm|rem|em|ch|vw|vh|vi|vb)?/g)) {
      const num = m[1], unit = (m[3] || "").trim();
      if (num) t.add(num);
      if (num && unit) t.add(num + unit);
    }

    // known keywords
    [
      "min-width","max-width","width",
      "min-height","max-height","height",
      "aspect-ratio","orientation",
      "resolution","device-pixel-ratio","monochrome",
      "inline-size","block-size",
      "pointer","any-pointer","hover","any-hover",
      "prefers-color-scheme","prefers-contrast","prefers-reduced-motion","prefers-reduced-data",
      "color-gamut","dynamic-range","display-mode","environment-blending"
    ].forEach(fn => { if (c.includes(fn)) t.add(fn); });

    if (c.includes("landscape")) t.add("landscape");
    if (c.includes("portrait"))  t.add("portrait");

    for (const m of c.matchAll(/(\d+)\s*\/\s*(\d+)/g)) t.add(`${m[1]}/${m[2]}`);

    return Array.from(t);
  }

  function tokensFromContainerCondition(cond) {
    const t = new Set();
    if (!cond) return [];

    const c = lower(cond);

    ["inline-size","block-size","style("].forEach(k => { if (c.includes(k)) t.add(k); });

    // numbers + units
    for (const m of c.matchAll(/(-?\d+(?:\.\d+)?)(\s*)(px|rem|em|ch|vw|vh|vi|vb)?/g)) {
      const num = m[1], unit = (m[3] || "").trim();
      if (num) t.add(num);
      if (num && unit) t.add(num + unit);
    }

    // style() idents e.g., style(color-scheme: dark) or style(--flag: on)
    for (const m of c.matchAll(/style\(\s*([^)]+)\)/g)) {
      const inside = m[1] || "";
      // pull ident-like pieces
      for (const id of inside.split(/[\s:;,/()+]+/)) {
        const tok = id.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(tok)) t.add(tok);
      }
    }

    return Array.from(t);
  }

  function tokensFromSupports(hay, keyword) {
    const t = new Set();
    const c = lower(hay || "");
    if (keyword && isUsefulToken(keyword)) t.add(lower(keyword));

    // property or function head
    const head = c.match(/([-\w]+)\s*[:(]/);
    if (head && isUsefulToken(head[1])) t.add(head[1]);

    // identifiers inside parentheses: e.g., blur, p3, oklab, has
    for (const m of c.matchAll(/\(([^)]+)\)/g)) {
      const inside = m[1] || "";
      for (const id of inside.split(/[\s,/:;+]+/)) {
        const tok = id.replace(/[^a-z0-9.+-]/g, "");
        if (isUsefulToken(tok)) t.add(tok);
      }
    }
    return Array.from(t);
  }

  function tokensFromUnicodeRange(cssText) {
    const t = new Set();
    const c = lower(cssText || "");
    for (const m of c.matchAll(/u\+[0-9a-f?-]+(?:-[0-9a-f?-]+)?/ig)) {
      const tok = (m[0] || "").toLowerCase();
      if (isUsefulToken(tok)) t.add(tok);
    }
    return Array.from(t);
  }

  function urlEchoesTokens(url, tokens) {
    if (!url || !tokens || !tokens.length) return false;
    const u = lower(url);
    for (const tok of tokens) {
      if (!tok) continue;
      // simple boundary check for alpha tokens to reduce accidental substring matches
      if (/^[a-z]+$/i.test(tok)) {
        // try rough word boundary by inserting separators set
        const pattern = new RegExp(`(^|[\\W_])${tok}($|[\\W_])`, "i");
        if (pattern.test(u)) return true;
      } else {
        if (u.includes(tok)) return true;
      }
    }
    return false;
  }

  // ---------------- 규칙 내 소스 식별 ----------------
  function identifySourceKeywords(rule) {
    const out = [];
    try {
      const type = ruleTypeName(rule);
      const cssText = lower(rule.cssText || "");
      const cond = lower(getConditionText(rule) || "");

      // @media — echo required
      if (type === "CSSMediaRule" || /@media\b/i.test(cssText)) {
        for (const m of MEDIA_SOURCES) {
          if (cond.includes(m.key)) {
            out.push({
              category: "@media",
              keyword: m.key,
              semanticGroup: m.group,
              claim: m.claim,
              excerpt: short(cond, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(cond)
            });
          }
        }
        for (const g of MEDIA_SOURCES_GEOMETRY) {
          if (cond.includes(g.key)) {
            out.push({
              category: "@media",
              keyword: g.key,
              semanticGroup: g.group,
              claim: g.claim,
              excerpt: short(cond, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(cond)
            });
          }
        }
      }

      // @supports — echo required
      if (type === "CSSSupportsRule" || /@supports\b/i.test(cssText)) {
        const hay = cond || cssText;
        for (const s of SUPPORTS_SOURCES) {
          if ((hay || "").includes(s.key)) {
            out.push({
              category: "@supports",
              keyword: s.key,
              semanticGroup: s.group,
              claim: s.claim,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromSupports(hay, s.key)
            });
          }
        }
        // Also treat generic supports as low-signal but still echo-matchable
        if (!SUPPORTS_SOURCES.some(s => (cond || cssText).includes(s.key))) {
          const genericTokens = tokensFromSupports(hay, "");
          if (genericTokens.length) {
            out.push({
              category: "@supports",
              keyword: "supports(generic)",
              semanticGroup: "engine feature",
              claim: "generic supports probe",
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: genericTokens
            });
          }
        }
      }

      // @container — echo required
      const isContainer = (type.toLowerCase().includes("container") || cssText.includes("@container"));
      if (isContainer) {
        const hay = cond || cssText;
        for (const c of CONTAINER_SOURCES) {
          if ((hay || "").includes(c.key)) {
            out.push({
              category: "@container",
              keyword: c.key,
              semanticGroup: c.group,
              claim: c.claim,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromContainerCondition(hay)
            });
          }
        }
      }

      // @font-face — local(...) path (echo required on font name)
      if (type === "CSSFontFaceRule" || /@font-face\b/i.test(cssText)) {
        if (cssText.includes(FONT_LOCAL_TOKEN)) {
          const localRegex = /local\(\s*['"]?([^'")]+)['"]?\s*\)/ig;
          let m;
          while ((m = localRegex.exec(cssText)) !== null) {
            const fontName = m[1] || "(local)";
            out.push({
              category: "@font-face",
              keyword: "local(",
              semanticGroup: "fonts",
              claim: `local font presence probe (${fontName})`,
              excerpt: short(cssText, 220),
              requiresEcho: true,
              echoTokens: [lower(fontName)]
            });
          }
        }
      }

      // @font-face — unicode-range only when local()+url() exist, and echo required (U+ tokens)
      if (type === "CSSFontFaceRule" || /@font-face\b/i.test(cssText)) {
        const hasUnicodeRange = cssText.includes("unicode-range");
        const hasLocal = cssText.includes("local(");
        const hasUrl = /url\(\s*['"][^'"]+['"]\s*\)/i.test(cssText);
        if (hasUnicodeRange && hasLocal && hasUrl) {
          out.push({
            category: "@font-face",
            keyword: "unicode-range",
            semanticGroup: "font coverage",
            claim: "unicode-range + local() may reveal local font coverage",
            excerpt: short(cssText, 220),
            requiresEcho: true,
            echoTokens: tokensFromUnicodeRange(cssText)
          });
        }
      }

      // @import — echo required when conditional media present
      if (type === "CSSImportRule" || /@import\b/i.test(cssText)) {
        let mediaTxt = "";
        try { if (rule.media && rule.media.mediaText) mediaTxt = lower(rule.media.mediaText || ""); } catch {}
        const hay = mediaTxt || "";
        for (const key of IMPORT_MEDIA_KEYS) {
          if ((hay || "").includes(key)) {
            out.push({
              category: "@import",
              keyword: key,
              semanticGroup: "import condition",
              claim: `conditional import via ${key}`,
              excerpt: short(hay, 220),
              requiresEcho: true,
              echoTokens: tokensFromMediaCondition(hay)
            });
          }
        }
      }

    } catch {}
    // 중복 제거
    const seen = new Set();
    return out.filter(x => {
      const id = `${x.category}::${x.keyword}::${x.claim}::${x.excerpt}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ---------------- 규칙 순회 (ancestor-aware) ----------------
  function walkRulesToList(rules, sheetHref, groupContext, outList, ancestorSources, totalCountBox) {
    if (!rules) return outList;
    outList = outList || [];
    ancestorSources = ancestorSources || [];
    for (let i = 0; i < rules.length; i++) {
      if (outList.length >= MAX_RULES_PER_SHEET) break;
      if (totalCountBox.count >= MAX_TOTAL_RULES) break;

      const rule = rules[i];
      const type = ruleTypeName(rule);
      const selector = ("selectorText" in rule && rule.selectorText) ? rule.selectorText : "";
      const cssText = rule.cssText || "";
      const groupCond = getConditionText(rule);

      const entry = {
        type,
        selector,
        cssText: short(cssText, URL_SNIPPET_LEN),
        urls: [],
        group: groupContext || groupCond || "",
        sources: [],
        sinks: [],
        inheritedSources: ancestorSources // reference to ancestor-derived sources
      };

      // 소스 탐지 - for current rule
      const srcs = identifySourceKeywords(rule);
      if (srcs.length) {
        entry.sources = srcs.map(s => ({
          reason: "keyword_match",
          category: s.category,
          keyword: s.keyword,
          semanticGroup: s.semanticGroup,
          claim: s.claim,
          excerpt: s.excerpt,
          requiresEcho: !!s.requiresEcho,
          echoTokens: s.echoTokens || []
        }));
      }

      // 싱크 탐지
      const sinkUrls = (cssText && extractUrlStrings(lower(cssText))).concat(
        type === "CSSImportRule" ? extractImportUrls(lower(cssText)) : []
      );
      if (sinkUrls.length > 0) {
        entry.urls = sinkUrls.slice();
        entry.sinks.push({ reason: "url_sink", urls: sinkUrls.slice() });
      }

      outList.push(entry);
      totalCountBox.count++;

      // Build new ancestor source stack for descendants:
      const mergedAncestorSources = []
        .concat(ancestorSources || [])
        .concat(entry.sources || []); // child sees parent groups plus this rule’s sources

      // 중첩 규칙 처리
      try {
        if (rule.cssRules && rule.cssRules.length) {
          walkRulesToList(
            rule.cssRules,
            sheetHref,
            groupCond || groupContext || "",
            outList,
            mergedAncestorSources,
            totalCountBox
          );
        }
      } catch {}
    }
    return outList;
  }

  // ---------------- 메인 실행 ----------------
  (function run() {
    const dump = {
      page: location.href,
      timestamp: Date.now(),
      sheets: [],
      inaccessible: []
    };

    const totalCountBox = { count: 0 };

    for (let s = 0; s < document.styleSheets.length; s++) {
      const sheet = document.styleSheets[s];
      const rec = { href: sheet.href || "(inline <style>)", rules: 0, rulesList: [] };
      try {
        if (sheet.cssRules) {
          rec.rulesList = walkRulesToList(sheet.cssRules, rec.href, "", [], [], totalCountBox);
          rec.rules = rec.rulesList.length;
        } else {
          rec.rules = 0;
        }
      } catch (e) {
        rec.rules = "inaccessible";
        dump.inaccessible.push(sheet.href || "(inline)");
      }
      dump.sheets.push(rec);
      if (totalCountBox.count >= MAX_TOTAL_RULES) break;
    }

    dump.styleTags = document.querySelectorAll("style").length;
    dump.inlineStyleCount = document.querySelectorAll("[style]").length;

    // 소스-싱크 연결 (같은 규칙 + 조상 그룹, echo 필수)
    dump.associations = [];
    const claimDetailsMap = new Map();

    for (const sheetRec of dump.sheets) {
      const list = sheetRec.rulesList || [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.sinks || !r.sinks.length) continue;

        const sinkUrls = (r.sinks[0].urls && r.sinks[0].urls.length) ? r.sinks[0].urls : [];
        for (const url of sinkUrls) {
          const assoc = { sheet: sheetRec.href, sinkRuleIndex: i, sinkUrl: url, matchedSources: [] };

          // candidate sources: same rule first, then inherited ancestor sources
          const candidateSources = []
            .concat(r.sources || [])
            .concat(r.inheritedSources || []);

          for (const s of candidateSources) {
            if (!s.requiresEcho) continue;
            if (!s.echoTokens || !s.echoTokens.length) continue;
            if (!urlEchoesTokens(url, s.echoTokens)) continue;

            assoc.matchedSources.push({
              ruleIndex: i,
              reason: r.sources && r.sources.includes(s) ? "same-rule" : "ancestor-group",
              category: s.category,
              keyword: s.keyword,
              claim: s.claim,
              semanticGroup: s.semanticGroup,
              excerpt: s.excerpt,
              echoConfirmed: true
            });

            const key = `${s.semanticGroup}|${s.claim}|${s.keyword}`;
            if (!claimDetailsMap.has(key)) {
              claimDetailsMap.set(key, {
                category: s.category,
                semanticGroup: s.semanticGroup,
                keyword: s.keyword,
                claim: s.claim,
                risk: riskFor(s.semanticGroup),
                explanation: explanationFor(s.semanticGroup, s.keyword, s.claim)
              });
            }
          }

          if (assoc.matchedSources.length) dump.associations.push(assoc);
        }
      }
    }

    // 요약/판정/리스크
    const claims = [];
    for (const a of dump.associations) {
      if (!a.matchedSources) continue;
      for (const s of a.matchedSources) claims.push(`${s.semanticGroup}: ${s.claim}`);
    }
    const uniqueClaims = Array.from(new Set(claims)).sort();

    dump.summary = {
      sheetsAccessible: dump.sheets.filter(s => s.rules !== "inaccessible").length,
      sheetsInaccessible: dump.inaccessible.length,
      totalRulesScanned: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList) ? s.rulesList.length : 0), 0),
      totalSinks: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sinks ? r.sinks.length : 0), 0) : 0), 0),
      totalSources: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sources ? r.sources.length : 0), 0) : 0), 0),
      totalAssociations: dump.associations.length,
      totalCapped: totalCountBox.count >= MAX_TOTAL_RULES
    };

    const hasLinked = dump.associations.some(a => a.matchedSources && a.matchedSources.length);
    dump.likelyFingerprinting = !!hasLinked;
    dump.verdict = hasLinked ? "likely fingerprinting" : "likely not fingerprinting";
    dump.claims = uniqueClaims;

    dump.claimDetails = Array.from(claimDetailsMap.values())
      .sort((a, b) => b.risk - a.risk || (a.claim || "").localeCompare(b.claim || ""));

    const totalRisk = dump.claimDetails.reduce((acc, c) => acc + (c.risk || 0), 0);
    dump.riskScore = totalRisk;
    dump.riskLevel = !hasLinked ? "none"
                     : totalRisk >= 7 ? "high"
                     : totalRisk >= 3 ? "medium" : "low";

    // 저장 + 확장으로 전송
    window.__lastCssDump = dump;
    try {
      chrome.runtime.sendMessage({ type: "cssDump", payload: dump }, function () {});
    } catch (e) {
      console.warn("chrome.runtime.sendMessage failed:", e);
      console.log("dump:", dump);
    }
  })();
}