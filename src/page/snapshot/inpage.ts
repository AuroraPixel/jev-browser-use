/**
 * In-page snapshot script. Evaluated as a string in Puppeteer's ISOLATED realm of a frame.
 * Installs window.__jevBrowserUse (idempotent). See ./index.ts for the contract.
 *
 * Port of do-browser's ariaSnapshot.ts (itself a port of Playwright's injected
 * ariaSnapshot) plus: stable refs, interactive mode, scope, depth, boxes,
 * iframe detection, frame-prefixed refs.
 *
 * window.__jevBrowserUse = {
 *   version,
 *   snapshot(opts) -> { yaml, refs, truncated, droppedLines, iframes: [{ ref, line, origin: [x, y] }] }
 *     opts: { scope, interactive, depth, boxes, urls, maxChars, refPrefix, boxOffset: [x, y] }
 *     boxOffset is added to every [box=...] (the iframe's content origin in main-viewport px,
 *     passed by the host for nested frames) so boxes are always main-viewport coordinates.
 *   ref(id)        -> Element | null   (accepts "e5" or "f1e5")
 *   box(id)        -> [x, y, w, h] | null   (frame-local viewport px)
 * }
 * window.__jevBrowserUseRefState = { lastRef, refMap, frameKey }: the ref counter, id map, and the
 * document's last snapshotted frame prefix, kept outside the versioned closure so a reinstall
 * (INPAGE_VERSION bump on a long-lived page) never reuses ids.
 *
 * NOTE: written with String.raw so regexes read like normal JS. Do not use
 * backticks or "${" inside the script body.
 */

export const INPAGE_VERSION = 14;

export const INPAGE_SCRIPT: string = String.raw`(() => {
  if (window.__jevBrowserUse && window.__jevBrowserUse.version === ${INPAGE_VERSION}) return;

  // === domUtils ===
  let cacheStyle;
  let cachesCounter = 0;

  function beginDOMCaches() {
    ++cachesCounter;
    cacheStyle = cacheStyle || new Map();
  }
  function endDOMCaches() {
    if (!--cachesCounter) cacheStyle = undefined;
  }
  function getElementComputedStyle(element, pseudo) {
    const cache = cacheStyle;
    const cacheKey = pseudo ? undefined : element;
    if (cache && cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
    const style = element.ownerDocument && element.ownerDocument.defaultView
      ? element.ownerDocument.defaultView.getComputedStyle(element, pseudo)
      : undefined;
    if (cache && cacheKey) cache.set(cacheKey, style);
    return style;
  }
  function parentElementOrShadowHost(element) {
    if (element.parentElement) return element.parentElement;
    if (!element.parentNode) return;
    if (element.parentNode.nodeType === 11 && element.parentNode.host) return element.parentNode.host;
  }
  function enclosingShadowRootOrDocument(element) {
    let node = element;
    while (node.parentNode) node = node.parentNode;
    if (node.nodeType === 11 || node.nodeType === 9) return node;
  }
  function closestCrossShadow(element, css, scope) {
    while (element) {
      const closest = element.closest(css);
      if (scope && closest !== scope && closest && closest.contains(scope)) return;
      if (closest) return closest;
      element = enclosingShadowHost(element);
    }
  }
  function enclosingShadowHost(element) {
    while (element.parentElement) element = element.parentElement;
    return parentElementOrShadowHost(element);
  }
  function isElementStyleVisibilityVisible(element, style) {
    style = style || getElementComputedStyle(element);
    if (!style) return true;
    if (style.visibility !== "visible") return false;
    const detailsOrSummary = element.closest("details,summary");
    if (detailsOrSummary !== element && detailsOrSummary && detailsOrSummary.nodeName === "DETAILS" && !detailsOrSummary.open) return false;
    return true;
  }
  function computeBox(element) {
    const style = getElementComputedStyle(element);
    if (!style) return { visible: true, inline: false };
    const cursor = style.cursor;
    if (style.display === "contents") {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isElementVisible(child)) return { visible: true, inline: false, cursor };
        if (child.nodeType === 3 && isVisibleTextNode(child)) return { visible: true, inline: true, cursor };
      }
      return { visible: false, inline: false, cursor };
    }
    if (!isElementStyleVisibilityVisible(element, style)) return { cursor, visible: false, inline: false };
    const rect = element.getBoundingClientRect();
    return { rect, cursor, visible: rect.width > 0 && rect.height > 0, inline: style.display === "inline" };
  }
  function isElementVisible(element) {
    return computeBox(element).visible;
  }
  function isVisibleTextNode(node) {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function elementSafeTagName(element) {
    const tagName = element.tagName;
    if (typeof tagName === "string") return tagName.toUpperCase();
    if (element instanceof HTMLFormElement) return "FORM";
    return String(element.tagName).toUpperCase();
  }
  function normalizeWhiteSpace(text) {
    return text.split("\u00A0").map(chunk =>
      chunk.replace(/\r\n/g, "\n").replace(/[\u200b\u00ad]/g, "").replace(/\s\s*/g, " ")
    ).join("\u00A0").trim();
  }

  // === yaml ===
  function yamlEscapeKeyIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str)) return str;
    return "'" + str.replace(/'/g, "''") + "'";
  }
  function yamlEscapeValueIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str)) return str;
    return '"' + str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => {
      switch (c) {
        case "\\": return "\\\\";
        case '"': return '\\"';
        case "\b": return "\\b";
        case "\f": return "\\f";
        case "\n": return "\\n";
        case "\r": return "\\r";
        case "\t": return "\\t";
        default: return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
      }
    }) + '"';
  }
  function yamlStringNeedsQuotes(str) {
    if (str.length === 0) return true;
    if (/^\s|\s$/.test(str)) return true;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
    if (/^-/.test(str)) return true;
    if (/[\n:](\s|$)/.test(str)) return true;
    if (/\s#/.test(str)) return true;
    if (/[\n\r]/.test(str)) return true;
    if (/^[&*\],?!>|@"'#%]/.test(str)) return true;
    if (/[{}]/.test(str)) return true;
    if (/^\[/.test(str)) return true;
    if (!isNaN(Number(str)) || ["y","n","yes","no","true","false","on","off","null"].includes(str.toLowerCase())) return true;
    return false;
  }

  // === roleUtils ===
  const validRoles = new Set(["alert","alertdialog","application","article","banner","blockquote","button","caption","cell","checkbox","code","columnheader","combobox","complementary","contentinfo","definition","deletion","dialog","directory","document","emphasis","feed","figure","form","generic","grid","gridcell","group","heading","img","insertion","link","list","listbox","listitem","log","main","mark","marquee","math","meter","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none","note","option","paragraph","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader","scrollbar","search","searchbox","separator","slider","spinbutton","status","strong","subscript","superscript","switch","tab","table","tablist","tabpanel","term","textbox","time","timer","toolbar","tooltip","tree","treegrid","treeitem"]);

  let cacheAccessibleName;
  let cacheIsHidden;
  let cachePointerEvents;
  let cacheRole;
  let cachePseudoContentBefore;
  let cachePseudoContentAfter;
  let ariaCachesCounter = 0;

  function beginAriaCaches() {
    beginDOMCaches();
    ++ariaCachesCounter;
    cacheAccessibleName = cacheAccessibleName || new Map();
    cacheIsHidden = cacheIsHidden || new Map();
    cachePointerEvents = cachePointerEvents || new Map();
    cacheRole = cacheRole || new Map();
    cachePseudoContentBefore = cachePseudoContentBefore || new Map();
    cachePseudoContentAfter = cachePseudoContentAfter || new Map();
  }
  function endAriaCaches() {
    if (!--ariaCachesCounter) {
      cacheAccessibleName = undefined;
      cacheIsHidden = undefined;
      cachePointerEvents = undefined;
      cacheRole = undefined;
      cachePseudoContentBefore = undefined;
      cachePseudoContentAfter = undefined;
    }
    endDOMCaches();
  }

  function hasExplicitAccessibleName(e) {
    return e.hasAttribute("aria-label") || e.hasAttribute("aria-labelledby");
  }
  const kAncestorPreventingLandmark = "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]";
  const kNamingProhibited = ["caption","code","deletion","emphasis","generic","insertion","paragraph","presentation","strong","subscript","superscript"];
  const kGlobalAriaAttributes = [
    ["aria-atomic", undefined],["aria-busy", undefined],["aria-controls", undefined],["aria-current", undefined],
    ["aria-describedby", undefined],["aria-details", undefined],["aria-dropeffect", undefined],["aria-flowto", undefined],
    ["aria-grabbed", undefined],["aria-hidden", undefined],["aria-keyshortcuts", undefined],
    ["aria-label", kNamingProhibited],["aria-labelledby", kNamingProhibited],
    ["aria-live", undefined],["aria-owns", undefined],["aria-relevant", undefined],["aria-roledescription", ["generic"]]
  ];
  function hasGlobalAriaAttribute(element, forRole) {
    return kGlobalAriaAttributes.some(([attr, prohibited]) => !(prohibited && prohibited.includes(forRole || "")) && element.hasAttribute(attr));
  }
  function hasTabIndex(element) {
    return !Number.isNaN(Number(String(element.getAttribute("tabindex"))));
  }
  function isFocusable(element) {
    return !isNativelyDisabled(element) && (isNativelyFocusable(element) || hasTabIndex(element));
  }
  function isNativelyFocusable(element) {
    const tagName = elementSafeTagName(element);
    if (["BUTTON","DETAILS","SELECT","TEXTAREA"].includes(tagName)) return true;
    if (tagName === "A" || tagName === "AREA") return element.hasAttribute("href");
    if (tagName === "INPUT") return !element.hidden;
    return false;
  }
  function isNativelyDisabled(element) {
    const isNativeFormControl = ["BUTTON","INPUT","SELECT","TEXTAREA","OPTION","OPTGROUP"].includes(elementSafeTagName(element));
    return isNativeFormControl && (element.hasAttribute("disabled") || belongsToDisabledFieldSet(element));
  }
  function belongsToDisabledFieldSet(element) {
    const fieldSetElement = element && element.closest("FIELDSET[DISABLED]");
    if (!fieldSetElement) return false;
    const legendElement = fieldSetElement.querySelector(":scope > LEGEND");
    return !legendElement || !legendElement.contains(element);
  }
  const inputTypeToRole = {button:"button",checkbox:"checkbox",image:"button",number:"spinbutton",radio:"radio",range:"slider",reset:"button",submit:"button"};
  function getIdRefs(element, ref) {
    if (!ref) return [];
    const root = enclosingShadowRootOrDocument(element);
    if (!root) return [];
    try {
      const ids = ref.split(" ").filter(id => !!id);
      const result = [];
      for (const id of ids) {
        const firstElement = root.querySelector("#" + CSS.escape(id));
        if (firstElement && !result.includes(firstElement)) result.push(firstElement);
      }
      return result;
    } catch (e) { return []; }
  }
  const kImplicitRoleByTagName = {
    A: e => e.hasAttribute("href") ? "link" : null,
    AREA: e => e.hasAttribute("href") ? "link" : null,
    ARTICLE: () => "article", ASIDE: () => "complementary", BLOCKQUOTE: () => "blockquote", BUTTON: () => "button",
    CAPTION: () => "caption", CODE: () => "code", DATALIST: () => "listbox", DD: () => "definition",
    DEL: () => "deletion", DETAILS: () => "group", DFN: () => "term", DIALOG: () => "dialog", DT: () => "term",
    EM: () => "emphasis", FIELDSET: () => "group", FIGURE: () => "figure",
    FOOTER: e => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "contentinfo",
    FORM: e => hasExplicitAccessibleName(e) ? "form" : null,
    H1: () => "heading", H2: () => "heading", H3: () => "heading", H4: () => "heading", H5: () => "heading", H6: () => "heading",
    HEADER: e => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "banner",
    HR: () => "separator", HTML: () => "document",
    IMG: e => e.getAttribute("alt") === "" && !e.getAttribute("title") && !hasGlobalAriaAttribute(e) && !hasTabIndex(e) ? "presentation" : "img",
    INPUT: e => {
      const type = String(e.type).toLowerCase();
      if (type === "search") return e.hasAttribute("list") ? "combobox" : "searchbox";
      if (["email","tel","text","url",""].includes(type)) {
        const list = getIdRefs(e, e.getAttribute("list"))[0];
        return list && elementSafeTagName(list) === "DATALIST" ? "combobox" : "textbox";
      }
      if (type === "hidden") return null;
      if (type === "file") return "button";
      return inputTypeToRole[type] || "textbox";
    },
    INS: () => "insertion", LI: () => "listitem", MAIN: () => "main", MARK: () => "mark", MATH: () => "math",
    MENU: () => "list", METER: () => "meter", NAV: () => "navigation", OL: () => "list", OPTGROUP: () => "group",
    OPTION: () => "option", OUTPUT: () => "status", P: () => "paragraph", PROGRESS: () => "progressbar",
    SEARCH: () => "search", SECTION: e => hasExplicitAccessibleName(e) ? "region" : null,
    SELECT: e => e.hasAttribute("multiple") || e.size > 1 ? "listbox" : "combobox",
    STRONG: () => "strong", SUB: () => "subscript", SUP: () => "superscript", SVG: () => "img",
    TABLE: () => "table", TBODY: () => "rowgroup",
    TD: e => { const table = closestCrossShadow(e, "table"); const role = table ? getExplicitAriaRole(table) : ""; return role === "grid" || role === "treegrid" ? "gridcell" : "cell"; },
    TEXTAREA: () => "textbox", TFOOT: () => "rowgroup",
    TH: e => { const scope = e.getAttribute("scope"); if (scope === "col" || scope === "colgroup") return "columnheader"; if (scope === "row" || scope === "rowgroup") return "rowheader"; return "columnheader"; },
    THEAD: () => "rowgroup", TIME: () => "time", TR: () => "row", UL: () => "list"
  };
  function getExplicitAriaRole(element) {
    const roles = (element.getAttribute("role") || "").split(" ").map(role => role.trim());
    return roles.find(role => validRoles.has(role)) || null;
  }
  function getImplicitAriaRole(element) {
    const fn = kImplicitRoleByTagName[elementSafeTagName(element)];
    return fn ? fn(element) : null;
  }
  function hasPresentationConflictResolution(element, role) {
    return hasGlobalAriaAttribute(element, role) || isFocusable(element);
  }
  function getAriaRole(element) {
    const cache = cacheRole;
    if (cache && cache.has(element)) return cache.get(element);
    let result;
    const explicitRole = getExplicitAriaRole(element);
    if (!explicitRole) result = getImplicitAriaRole(element);
    else if (explicitRole === "none" || explicitRole === "presentation") {
      const implicitRole = getImplicitAriaRole(element);
      result = hasPresentationConflictResolution(element, implicitRole) ? implicitRole : explicitRole;
    } else result = explicitRole;
    if (cache) cache.set(element, result);
    return result;
  }
  function getAriaBoolean(attr) {
    return attr === null ? undefined : attr.toLowerCase() === "true";
  }
  function isElementIgnoredForAria(element) {
    return ["STYLE","SCRIPT","NOSCRIPT","TEMPLATE"].includes(elementSafeTagName(element));
  }
  function isElementHiddenForAria(element) {
    if (isElementIgnoredForAria(element)) return true;
    const style = getElementComputedStyle(element);
    const isSlot = element.nodeName === "SLOT";
    if (style && style.display === "contents" && !isSlot) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && !isElementHiddenForAria(child)) return false;
        if (child.nodeType === 3 && isVisibleTextNode(child)) return false;
      }
      return true;
    }
    const isOptionInsideSelect = element.nodeName === "OPTION" && !!element.closest("select");
    if (!isOptionInsideSelect && !isSlot && !isElementStyleVisibilityVisible(element, style)) return true;
    return belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element);
  }
  function belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element) {
    let hidden = cacheIsHidden ? cacheIsHidden.get(element) : undefined;
    if (hidden === undefined) {
      hidden = false;
      if (element.parentElement && element.parentElement.shadowRoot && !element.assignedSlot) hidden = true;
      if (!hidden) {
        const style = getElementComputedStyle(element);
        hidden = !style || style.display === "none" || getAriaBoolean(element.getAttribute("aria-hidden")) === true;
      }
      if (!hidden) {
        const parent = parentElementOrShadowHost(element);
        if (parent) hidden = belongsToDisplayNoneOrAriaHiddenOrNonSlotted(parent);
      }
      if (cacheIsHidden) cacheIsHidden.set(element, hidden);
    }
    return hidden;
  }
  function getAriaLabelledByElements(element) {
    const ref = element.getAttribute("aria-labelledby");
    if (ref === null) return null;
    const refs = getIdRefs(element, ref);
    return refs.length ? refs : null;
  }
  const kNamingProhibitedRoles = ["caption","code","definition","deletion","emphasis","generic","insertion","mark","paragraph","presentation","strong","subscript","suggestion","superscript","term","time"];
  function getElementAccessibleName(element, includeHidden) {
    let accessibleName = cacheAccessibleName ? cacheAccessibleName.get(element) : undefined;
    if (accessibleName === undefined) {
      accessibleName = "";
      const elementProhibitsNaming = kNamingProhibitedRoles.includes(getAriaRole(element) || "");
      if (!elementProhibitsNaming) {
        accessibleName = normalizeWhiteSpace(getTextAlternativeInternal(element, { includeHidden, visitedElements: new Set(), embeddedInTargetElement: "self" }));
      }
      if (cacheAccessibleName) cacheAccessibleName.set(element, accessibleName);
    }
    return accessibleName;
  }
  const kDescendantNameFromContentRoles = ["","caption","code","contentinfo","definition","deletion","emphasis","insertion","list","listitem","mark","none","paragraph","presentation","region","row","rowgroup","section","strong","subscript","superscript","table","term","time","generic"];
  // "row" is deliberately omitted: its content name repeats every cell/link of the row (very costly on tables).
  const kNameFromContentRoles = ["button","cell","checkbox","columnheader","gridcell","heading","link","menuitem","menuitemcheckbox","menuitemradio","option","radio","rowheader","switch","tab","tooltip","treeitem"];
  function getTextAlternativeInternal(element, options) {
    if (options.visitedElements.has(element)) return "";
    const childOptions = Object.assign({}, options, { embeddedInTargetElement: options.embeddedInTargetElement === "self" ? "descendant" : options.embeddedInTargetElement });
    if (!options.includeHidden) {
      const isEmbeddedInHiddenReferenceTraversal = !!(options.embeddedInLabelledBy && options.embeddedInLabelledBy.hidden) || !!(options.embeddedInLabel && options.embeddedInLabel.hidden) || !!(options.embeddedInNativeTextAlternative && options.embeddedInNativeTextAlternative.hidden);
      if (isElementIgnoredForAria(element) || (!isEmbeddedInHiddenReferenceTraversal && isElementHiddenForAria(element))) {
        options.visitedElements.add(element);
        return "";
      }
    }
    const labelledBy = getAriaLabelledByElements(element);
    if (!options.embeddedInLabelledBy) {
      const accessibleName = (labelledBy || []).map(ref => getTextAlternativeInternal(ref, Object.assign({}, options, { embeddedInLabelledBy: { element: ref, hidden: isElementHiddenForAria(ref) }, embeddedInTargetElement: undefined, embeddedInLabel: undefined, embeddedInNativeTextAlternative: undefined }))).join(" ");
      if (accessibleName) return accessibleName;
    }
    const role = getAriaRole(element) || "";
    const tagName = elementSafeTagName(element);
    // 2e: embedded control inside a label / labelledby target / naming ancestor contributes its value.
    if (!!options.embeddedInLabel || !!options.embeddedInLabelledBy || options.embeddedInTargetElement === "descendant") {
      const isOwnLabel = [...(element.labels || [])].includes(options.embeddedInLabel && options.embeddedInLabel.element);
      const isOwnLabelledBy = (getAriaLabelledByElements(element) || []).includes(options.embeddedInLabelledBy && options.embeddedInLabelledBy.element);
      if (!isOwnLabel && !isOwnLabelledBy) {
        if (role === "textbox") {
          options.visitedElements.add(element);
          if (tagName === "INPUT" || tagName === "TEXTAREA") return element.value;
          return element.textContent || "";
        }
        if (["combobox","listbox"].includes(role)) {
          options.visitedElements.add(element);
          let selectedOptions;
          if (tagName === "SELECT") {
            selectedOptions = [...element.selectedOptions];
            if (!selectedOptions.length && element.options.length) selectedOptions.push(element.options[0]);
          } else {
            const listbox = role === "combobox" ? [...element.querySelectorAll("*")].find(e => getAriaRole(e) === "listbox") : element;
            selectedOptions = listbox ? [...listbox.querySelectorAll('[aria-selected="true"]')].filter(e => getAriaRole(e) === "option") : [];
          }
          if (!selectedOptions.length && tagName === "INPUT") return element.value;
          return selectedOptions.map(option => getTextAlternativeInternal(option, childOptions)).join(" ");
        }
        if (["progressbar","scrollbar","slider","spinbutton","meter"].includes(role)) {
          options.visitedElements.add(element);
          const valueText = element.getAttribute("aria-valuetext");
          if (valueText) return valueText;
          const valueNow = element.getAttribute("aria-valuenow");
          if (valueNow) return valueNow;
          if (tagName === "INPUT") return element.value;
          return "";
        }
        if (role === "menu") { options.visitedElements.add(element); return ""; }
      }
    }
    const ariaLabel = element.getAttribute("aria-label") || "";
    if (ariaLabel.trim()) { options.visitedElements.add(element); return ariaLabel; }
    if (!["presentation","none"].includes(role)) {
      if (tagName === "INPUT" && ["button","submit","reset"].includes(element.type)) {
        options.visitedElements.add(element);
        const value = element.value || "";
        if (value.trim()) return value;
        if (element.type === "submit") return "Submit";
        if (element.type === "reset") return "Reset";
        return element.getAttribute("title") || "";
      }
      if (tagName === "INPUT" && element.type === "image") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (alt.trim()) return alt;
        const title = element.getAttribute("title") || "";
        if (title.trim()) return title;
        return "Submit";
      }
      if (tagName === "INPUT" && element.type === "file") {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length && !options.embeddedInLabelledBy) return getAccessibleNameFromAssociatedLabels(labels, options);
        return "Choose File";
      }
      if (tagName === "IMG") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (alt.trim()) return alt;
        return element.getAttribute("title") || "";
      }
      if (!labelledBy && (tagName === "BUTTON" || tagName === "OUTPUT")) {
        const labels = element.labels;
        if (labels && labels.length) {
          options.visitedElements.add(element);
          return getAccessibleNameFromAssociatedLabels(labels, options);
        }
      }
      if (!labelledBy && ["INPUT","TEXTAREA","SELECT"].includes(tagName)) {
        options.visitedElements.add(element);
        const labels = element.labels;
        if (labels && labels.length) return getAccessibleNameFromAssociatedLabels(labels, options);
        const usePlaceholder = (tagName === "INPUT" && ["text","password","search","tel","email","url"].includes(element.type)) || tagName === "TEXTAREA";
        const placeholder = element.getAttribute("placeholder") || "";
        const title = element.getAttribute("title") || "";
        if (!usePlaceholder || title) return title;
        return placeholder;
      }
      if (!labelledBy && (tagName === "FIELDSET" || tagName === "FIGURE" || tagName === "TABLE")) {
        options.visitedElements.add(element);
        const captionTag = tagName === "FIELDSET" ? "LEGEND" : tagName === "FIGURE" ? "FIGCAPTION" : "CAPTION";
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === captionTag) {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, { embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) } }));
          }
        }
        if (tagName === "TABLE") { const summary = element.getAttribute("summary") || ""; if (summary) return summary; }
        else return element.getAttribute("title") || "";
      }
      if (tagName === "SVG" || element.ownerSVGElement) {
        options.visitedElements.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === "TITLE" && child.ownerSVGElement) {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, { embeddedInLabelledBy: { element: child, hidden: isElementHiddenForAria(child) } }));
          }
        }
      }
      if (element.ownerSVGElement && tagName === "A") {
        const title = element.getAttribute("xlink:title") || "";
        if (title.trim()) { options.visitedElements.add(element); return title; }
      }
    }
    // 2f: name from content. Playwright's allowsNameFromContent(role, targetDescendant): a descendant of a
    // naming element contributes its text even when its own role (span/div/p/strong/li/...) would not.
    const allowsNameFromContent = kNameFromContentRoles.includes(role) || (options.embeddedInTargetElement === "descendant" && kDescendantNameFromContentRoles.includes(role));
    const shouldNameFromContentForSummary = tagName === "SUMMARY" && !["presentation","none"].includes(role);
    if (allowsNameFromContent || shouldNameFromContentForSummary || !!options.embeddedInLabelledBy || !!options.embeddedInLabel || !!options.embeddedInNativeTextAlternative) {
      options.visitedElements.add(element);
      const accessibleName = innerAccumulatedElementText(element, childOptions);
      const maybeTrimmedAccessibleName = options.embeddedInTargetElement === "self" ? accessibleName.trim() : accessibleName;
      if (maybeTrimmedAccessibleName) return accessibleName;
    }
    if (!["presentation","none"].includes(role) || tagName === "IFRAME") {
      options.visitedElements.add(element);
      const title = element.getAttribute("title") || "";
      if (title.trim()) return title;
    }
    options.visitedElements.add(element);
    return "";
  }
  function innerAccumulatedElementText(element, options) {
    const tokens = [];
    const visit = (node, skipSlotted) => {
      if (skipSlotted && node.assignedSlot) return;
      if (node.nodeType === 1) {
        const style = getElementComputedStyle(node);
        const display = (style && style.display) || "inline";
        let token = getTextAlternativeInternal(node, options);
        if (display !== "inline" || node.nodeName === "BR") token = " " + token + " ";
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(node.textContent || "");
      }
    };
    tokens.push(getCSSContent(element, "::before") || "");
    const content = getCSSContent(element);
    if (content !== undefined) {
      tokens.push(content);
    } else {
      const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes) visit(child, false);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) visit(child, true);
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(child, true);
        }
        if (element.hasAttribute("aria-owns")) {
          for (const owned of getIdRefs(element, element.getAttribute("aria-owns"))) visit(owned, true);
        }
      }
    }
    tokens.push(getCSSContent(element, "::after") || "");
    return tokens.join("");
  }
  function getAccessibleNameFromAssociatedLabels(labels, options) {
    return [...labels].map(label => getTextAlternativeInternal(label, Object.assign({}, options, { embeddedInLabel: { element: label, hidden: isElementHiddenForAria(label) }, embeddedInNativeTextAlternative: undefined, embeddedInLabelledBy: undefined, embeddedInTargetElement: undefined }))).filter(name => !!name).join(" ");
  }

  const kAriaCheckedRoles = ["checkbox","menuitemcheckbox","option","radio","switch","menuitemradio","treeitem"];
  function getAriaChecked(element) {
    const tagName = elementSafeTagName(element);
    if (tagName === "INPUT" && element.indeterminate) return "mixed";
    if (tagName === "INPUT" && ["checkbox","radio"].includes(element.type)) return element.checked;
    if (kAriaCheckedRoles.includes(getAriaRole(element) || "")) {
      const checked = element.getAttribute("aria-checked");
      if (checked === "true") return true;
      if (checked === "mixed") return "mixed";
      return false;
    }
    return false;
  }
  const kAriaDisabledRoles = ["application","button","composite","gridcell","group","input","link","menuitem","scrollbar","separator","tab","checkbox","columnheader","combobox","grid","listbox","menu","menubar","menuitemcheckbox","menuitemradio","option","radio","radiogroup","row","rowheader","searchbox","select","slider","spinbutton","switch","tablist","textbox","toolbar","tree","treegrid","treeitem"];
  function getAriaDisabled(element) {
    return isNativelyDisabled(element) || hasExplicitAriaDisabled(element);
  }
  function hasExplicitAriaDisabled(element, isAncestor) {
    if (!element) return false;
    if (isAncestor || kAriaDisabledRoles.includes(getAriaRole(element) || "")) {
      const attribute = (element.getAttribute("aria-disabled") || "").toLowerCase();
      if (attribute === "true") return true;
      if (attribute === "false") return false;
      return hasExplicitAriaDisabled(parentElementOrShadowHost(element), true);
    }
    return false;
  }
  const kAriaExpandedRoles = ["application","button","checkbox","combobox","gridcell","link","listbox","menuitem","row","rowheader","tab","treeitem","columnheader","menuitemcheckbox","menuitemradio","switch"];
  function getAriaExpanded(element) {
    if (elementSafeTagName(element) === "DETAILS") return element.open;
    if (kAriaExpandedRoles.includes(getAriaRole(element) || "")) {
      const expanded = element.getAttribute("aria-expanded");
      if (expanded === null) return undefined;
      return expanded === "true";
    }
    return undefined;
  }
  const kAriaLevelRoles = ["heading","listitem","row","treeitem"];
  function getAriaLevel(element) {
    const native = {H1:1,H2:2,H3:3,H4:4,H5:5,H6:6}[elementSafeTagName(element)];
    if (native) return native;
    if (kAriaLevelRoles.includes(getAriaRole(element) || "")) {
      const attr = element.getAttribute("aria-level");
      const value = attr === null ? Number.NaN : Number(attr);
      if (Number.isInteger(value) && value >= 1) return value;
    }
    return 0;
  }
  const kAriaPressedRoles = ["button"];
  function getAriaPressed(element) {
    if (kAriaPressedRoles.includes(getAriaRole(element) || "")) {
      const pressed = element.getAttribute("aria-pressed");
      if (pressed === "true") return true;
      if (pressed === "mixed") return "mixed";
    }
    return false;
  }
  const kAriaSelectedRoles = ["gridcell","option","row","tab","rowheader","columnheader","treeitem"];
  function getAriaSelected(element) {
    if (elementSafeTagName(element) === "OPTION") return element.selected;
    if (kAriaSelectedRoles.includes(getAriaRole(element) || "")) return getAriaBoolean(element.getAttribute("aria-selected")) === true;
    return false;
  }
  function receivesPointerEvents(element) {
    const cache = cachePointerEvents;
    let e = element;
    let result;
    const parents = [];
    for (; e; e = parentElementOrShadowHost(e)) {
      const cached = cache ? cache.get(e) : undefined;
      if (cached !== undefined) { result = cached; break; }
      parents.push(e);
      const style = getElementComputedStyle(e);
      if (!style) { result = true; break; }
      const value = style.pointerEvents;
      if (value) { result = value !== "none"; break; }
    }
    if (result === undefined) result = true;
    if (cache) for (const parent of parents) cache.set(parent, result);
    return result;
  }
  // Text contributed by CSS content (the element's own, or its ::before/::after pseudo). Only string tokens
  // count (Playwright's parseCSSContentPropertyAsString): url()/counter()/attr()/open-quote yield nothing.
  function getCSSContent(element, pseudo) {
    const cache = pseudo === "::before" ? cachePseudoContentBefore : pseudo === "::after" ? cachePseudoContentAfter : undefined;
    if (cache && cache.has(element)) return cache.get(element);
    const style = getElementComputedStyle(element, pseudo);
    let content;
    if (style) {
      const contentValue = style.content;
      if (contentValue && contentValue !== "none" && contentValue !== "normal" && style.display !== "none" && style.visibility !== "hidden") {
        content = parseCSSContentAsString(contentValue);
      }
    }
    if (pseudo && content !== undefined) {
      const display = (style && style.display) || "inline";
      if (display !== "inline") content = " " + content + " ";
    }
    if (cache) cache.set(element, content);
    return content;
  }
  function parseCSSContentAsString(value) {
    // "a" "b" -> ab; anything that is not a quoted string (url(), counter(), attr(), keywords) is dropped.
    // Alternative text after "/" (content: url(x) / "alt") wins when present.
    const slash = value.indexOf(" / ");
    if (slash !== -1) value = value.slice(slash + 3);
    value = value.replace(/[a-z-]+\([^)]*\)/gi, ""); // url("x"), counter(), attr(), image-set()...
    let out = "";
    let found = false;
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(value))) {
      found = true;
      out += (m[1] !== undefined ? m[1] : m[2]).replace(/\\(.)/g, "$1");
    }
    return found ? out : undefined;
  }

  // === refs (persist for the lifetime of the document) ===
  // The counter and the id -> element map live on the window of the isolated world, NOT in this closure:
  // a newer jev-browser-use (higher INPAGE_VERSION) reinstalling into a long-lived page keeps handing out fresh ids
  // instead of restarting at e1 while old elements still carry their expando refs.
  const refState = window.__jevBrowserUseRefState || (window.__jevBrowserUseRefState = { lastRef: 0, refMap: new Map() });
  const refMap = refState.refMap; // "e5" -> WeakRef<Element> | Element
  const REF_KEY = "__jevBrowserUseRef";
  const HasWeakRef = typeof WeakRef === "function";

  function localRefId(id) {
    const m = /^(f\d+)?(e\d+)$/.exec(String(id));
    // A full frame ref is also a document-generation check. Host routing keeps
    // the prefix intact so a delayed/retried query cannot resolve the same eN
    // after this frame has navigated and received a new fN.
    if (!m || (m[1] && m[1] !== refState.frameKey)) return null;
    return m[2];
  }
  function refElement(id) {
    const local = localRefId(id);
    if (!local) return null;
    const entry = refMap.get(local);
    if (!entry) return null;
    const el = HasWeakRef && entry instanceof WeakRef ? entry.deref() : entry;
    if (!el || !el.isConnected) return null;
    return el;
  }
  function refBox(id) {
    const el = refElement(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  const INTERACTIVE_ROLES = new Set(["link","button","textbox","checkbox","radio","combobox","listbox","option","menuitem","menuitemcheckbox","menuitemradio","tab","switch","slider","searchbox","spinbutton","treeitem","scrollbar"]);
  // Always kept in interactive mode together with their text: feedback an agent needs to verify an action.
  const FEEDBACK_ROLES = new Set(["alert","alertdialog","status","log","marquee","timer","tooltip"]);
  const CONTEXT_ROLES = new Set(["banner","navigation","main","complementary","contentinfo","region","search","form","dialog","alertdialog","heading","tablist","menu","menubar","radiogroup","toolbar","tree","treegrid","grid","table","row","article","iframe"]);

  function isInteractiveNode(node) {
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (node.role === "iframe") return true;
    // A pointer cursor marks an element as clickable only where it is not inherited from a clickable ancestor.
    if (node.box && node.box.cursor === "pointer" && !node.pointerInherited) return true;
    const el = node.element;
    if (el && (el.hasAttribute("onclick") || el.isContentEditable)) return true;
    return false;
  }
  function isFeedbackNode(node) {
    if (FEEDBACK_ROLES.has(node.role)) return true;
    const el = node.element;
    if (!el) return false;
    const live = el.getAttribute("aria-live");
    return !!live && live.toLowerCase() !== "off";
  }
  // Own (non-inherited) reason to be clickable: click handler, tabindex, or a pointer cursor set on this element.
  function hasOwnInteractivity(element, box, pointerInherited) {
    if (element.hasAttribute("onclick") || hasTabIndex(element)) return true;
    return !!box && box.cursor === "pointer" && !pointerInherited;
  }

  // === tree generation ===
  function generateAriaTree(rootElement, options) {
    const visited = new Set();
    const snapshot = {
      root: { role: "fragment", name: "", children: [], element: rootElement, props: {}, box: computeBox(rootElement), receivesPointerEvents: true },
      iframeRefs: []
    };

    const visit = (ariaNode, node, parentElementVisible, pointerInherited) => {
      if (visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3 && node.nodeValue) {
        if (!parentElementVisible) return;
        if (ariaNode.role !== "textbox") ariaNode.children.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node;
      const isElementVisibleForAria = !isElementHiddenForAria(element);
      const visible = isElementVisibleForAria || isElementVisible(element);
      const ariaChildren = [];
      if (element.hasAttribute("aria-owns")) {
        const ids = element.getAttribute("aria-owns").split(/\s+/);
        for (const id of ids) {
          const ownedElement = rootElement.ownerDocument.getElementById(id);
          if (ownedElement) ariaChildren.push(ownedElement);
        }
      }
      const childAriaNode = visible ? toAriaNode(element, options, pointerInherited) : null;
      if (childAriaNode) ariaNode.children.push(childAriaNode);
      if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") return;
      if (childAriaNode && childAriaNode.editableText !== undefined) return; // contenteditable textbox: value shown, DOM children skipped
      // Descendants of an element that already shows [cursor=pointer] inherit the cursor; they are not clickable on their own.
      // Only a rendered ancestor that got a ref counts (not role=presentation, display:contents or pointer-events:none wrappers).
      const childPointerInherited = pointerInherited || !!(childAriaNode && providesPointerCursor(childAriaNode));
      processElement(childAriaNode || ariaNode, element, ariaChildren, visible, childPointerInherited);
    };

    function processElement(ariaNode, element, ariaChildren, parentElementVisible, pointerInherited) {
      const style = getElementComputedStyle(element);
      const display = (style && style.display) || "inline";
      const treatAsBlock = display !== "inline" || element.nodeName === "BR" ? " " : "";
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);
      ariaNode.children.push(getCSSContent(element, "::before") || "");
      const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes) visit(ariaNode, child, parentElementVisible, pointerInherited);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          if (!child.assignedSlot) visit(ariaNode, child, parentElementVisible, pointerInherited);
        }
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(ariaNode, child, parentElementVisible, pointerInherited);
        }
      }
      for (const child of ariaChildren) visit(ariaNode, child, parentElementVisible, pointerInherited);
      ariaNode.children.push(getCSSContent(element, "::after") || "");
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);
      if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0]) ariaNode.children = [];
      if (ariaNode.role === "link" && element.hasAttribute("href") && options.urls !== false) ariaNode.props["url"] = element.getAttribute("href");
      if (ariaNode.role === "textbox" && element.hasAttribute("placeholder") && element.getAttribute("placeholder") !== ariaNode.name) ariaNode.props["placeholder"] = element.getAttribute("placeholder");
    }

    beginAriaCaches();
    try { visit(snapshot.root, rootElement, true, false); }
    finally { endAriaCaches(); }
    normalizeStringChildren(snapshot.root);
    normalizeGenericRoles(snapshot.root);
    return snapshot;
  }

  function shouldHaveRef(ariaNode) {
    // A generic under an element that already carries the pointer ref (link/button/clickable div) is not a
    // separate click target: no ref unless it is clickable on its own.
    if (ariaNode.role === "generic" && ariaNode.pointerInherited && !hasOwnInteractivity(ariaNode.element, ariaNode.box, true)) return false;
    if (ariaNode.box.visible && ariaNode.receivesPointerEvents) return true;
    if (INTERACTIVE_ROLES.has(ariaNode.role)) {
      if (ariaNode.role === "option" && ariaNode.element.closest("select,datalist")) return false;
      return true;
    }
    return false;
  }

  function computeAriaRef(ariaNode, options) {
    if (!shouldHaveRef(ariaNode)) return;
    const element = ariaNode.element;
    let ariaRef = element[REF_KEY];
    if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
      ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: "e" + (++refState.lastRef) };
      try { Object.defineProperty(element, REF_KEY, { value: ariaRef, configurable: true, writable: true, enumerable: false }); }
      catch (e) { element[REF_KEY] = ariaRef; }
      refMap.set(ariaRef.ref, HasWeakRef ? new WeakRef(element) : element);
    } else if (!refMap.has(ariaRef.ref)) {
      refMap.set(ariaRef.ref, HasWeakRef ? new WeakRef(element) : element);
    }
    ariaNode.ref = (options.refPrefix || "") + ariaRef.ref;
  }

  function toAriaNode(element, options, pointerInherited) {
    const doc = element.ownerDocument;
    const active = doc.activeElement === element && element !== doc.body;
    if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") {
      const ariaNode = { role: "iframe", name: "", children: [], props: {}, element, box: computeBox(element), receivesPointerEvents: true, active, pointerInherited };
      computeAriaRef(ariaNode, options);
      return ariaNode;
    }
    const role = getAriaRole(element) || "generic";
    if (role === "presentation" || role === "none") return null;
    const name = normalizeWhiteSpace(getElementAccessibleName(element, false) || "");
    const receivesPointerEventsValue = receivesPointerEvents(element);
    const box = computeBox(element);
    // Inline span with a single text node: inline its text into the parent unless it is clickable on its own.
    if (role === "generic" && box.inline && element.childNodes.length === 1 && element.childNodes[0].nodeType === 3 && !hasOwnInteractivity(element, box, pointerInherited)) return null;
    const result = { role, name, children: [], props: {}, element, box, receivesPointerEvents: receivesPointerEventsValue, active, pointerInherited };
    computeAriaRef(result, options);
    if (kAriaCheckedRoles.includes(role)) result.checked = getAriaChecked(element);
    if (kAriaDisabledRoles.includes(role)) result.disabled = getAriaDisabled(element);
    if (kAriaExpandedRoles.includes(role)) result.expanded = getAriaExpanded(element);
    if (kAriaLevelRoles.includes(role)) result.level = getAriaLevel(element);
    if (kAriaPressedRoles.includes(role)) result.pressed = getAriaPressed(element);
    if (kAriaSelectedRoles.includes(role)) result.selected = getAriaSelected(element);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const t = element.type;
      if (t !== "checkbox" && t !== "radio" && t !== "file" && t !== "password" && t !== "hidden") result.children = [element.value];
    } else if (role === "textbox" && element.isContentEditable) {
      // contenteditable editor (ProseMirror, Quill, Gmail compose...): show its text as the value.
      let text = normalizeWhiteSpace(element.innerText || element.textContent || "");
      if (text.length > 2000) text = text.slice(0, 2000) + "\u2026";
      result.editableText = text;
      result.children = text ? [text] : [];
    }
    return result;
  }

  function normalizeGenericRoles(node) {
    const normalizeChildren = (node) => {
      const result = [];
      for (const child of node.children || []) {
        if (typeof child === "string") { result.push(child); continue; }
        result.push(...normalizeChildren(child));
      }
      const removeSelf = node.role === "generic" && !node.name && result.length <= 1 && result.every(c => typeof c !== "string" && !!c.ref);
      if (removeSelf) return result;
      // Collapsing generics may leave a single text equal to the name (svg <title> text next to a <path>): dedupe again.
      node.children = result.length === 1 && result[0] === node.name ? [] : result;
      return [node];
    };
    normalizeChildren(node);
  }

  function normalizeStringChildren(rootA11yNode) {
    const flushChildren = (buffer, normalizedChildren) => {
      if (!buffer.length) return;
      const text = normalizeWhiteSpace(buffer.join(""));
      if (text) normalizedChildren.push(text);
      buffer.length = 0;
    };
    const visit = (ariaNode) => {
      const normalizedChildren = [];
      const buffer = [];
      for (const child of ariaNode.children || []) {
        if (typeof child === "string") buffer.push(child);
        else { flushChildren(buffer, normalizedChildren); visit(child); normalizedChildren.push(child); }
      }
      flushChildren(buffer, normalizedChildren);
      ariaNode.children = normalizedChildren.length ? normalizedChildren : [];
      if (ariaNode.children.length === 1 && ariaNode.children[0] === ariaNode.name) ariaNode.children = [];
    };
    visit(rootA11yNode);
  }

  // interactive mode: keep interactive nodes + heading/landmark ancestors with kept descendants.
  // Feedback (alert/status/log/tooltip/aria-live) and dialog text are kept verbatim: that is what an agent verifies.
  function pruneInteractive(root) {
    const prune = (node, inInteractive) => {
      const out = [];
      for (const child of node.children) {
        if (typeof child === "string") { if (inInteractive) out.push(child); continue; }
        if (isFeedbackNode(child)) { out.push(child); continue; }
        const inter = isInteractiveNode(child);
        const ctx = CONTEXT_ROLES.has(child.role);
        const dialog = child.role === "dialog" || child.role === "alertdialog";
        const kids = prune(child, inter || dialog ? true : (ctx ? false : inInteractive));
        if (inter || child.role === "heading") { child.children = kids; out.push(child); }
        else if (dialog) { child.children = kids; out.push(child); }
        else if (ctx && kids.length) { child.children = kids; out.push(child); }
        else if (child.role === "paragraph" && inInteractive) { child.children = kids; out.push(child); }
        else out.push(...kids);
      }
      return out;
    };
    root.children = prune(root, false);
  }

  function hasPointerCursor(ariaNode) { return ariaNode.box.cursor === "pointer"; }
  // The node itself is the click target for its [cursor=pointer]: ref'd, laid out, receives pointer events.
  function providesPointerCursor(ariaNode) { return !!ariaNode.ref && !!ariaNode.box.rect && ariaNode.receivesPointerEvents && hasPointerCursor(ariaNode); }
  // Roles that are interactive by definition: [cursor=pointer] adds nothing for them
  // (it is ~20% of a link-heavy snapshot), so it is only rendered on other roles.
  const kImplicitlyClickableRoles = new Set(["link","button","checkbox","radio","combobox","textbox","searchbox","menuitem","menuitemcheckbox","menuitemradio","tab","switch","option","slider","spinbutton","listbox","menu","menubar","tablist","treeitem"]);
  function showsPointerCursor(ariaNode) { return hasPointerCursor(ariaNode) && !kImplicitlyClickableRoles.has(ariaNode.role); }

  function renderAriaTree(ariaSnapshot, options) {
    const lines = [];
    const iframes = [];
    let refCount = 0;
    const maxDepth = options.depth > 0 ? options.depth : 0;
    const offX = options.boxOffset ? options.boxOffset[0] || 0 : 0;
    const offY = options.boxOffset ? options.boxOffset[1] || 0 : 0;
    const nodesToRender = ariaSnapshot.root.role === "fragment" ? ariaSnapshot.root.children : [ariaSnapshot.root];

    const visitText = (text, indent) => {
      const escaped = yamlEscapeValueIfNeeded(text);
      if (escaped) lines.push(indent + "- text: " + escaped);
    };
    const createKey = (ariaNode, renderCursorPointer, depthCut) => {
      let key = ariaNode.role;
      if (ariaNode.name && ariaNode.name.length <= 900) {
        const name = ariaNode.name;
        const stringifiedName = name.startsWith("/") && name.endsWith("/") ? name : JSON.stringify(name);
        key += " " + stringifiedName;
      }
      if (ariaNode.checked === "mixed") key += " [checked=mixed]";
      if (ariaNode.checked === true) key += " [checked]";
      if (ariaNode.disabled) key += " [disabled]";
      if (ariaNode.expanded) key += " [expanded]";
      if (ariaNode.active) key += " [active]";
      if (ariaNode.level) key += " [level=" + ariaNode.level + "]";
      if (ariaNode.pressed === "mixed") key += " [pressed=mixed]";
      if (ariaNode.pressed === true) key += " [pressed]";
      if (ariaNode.selected === true) key += " [selected]";
      if (ariaNode.ref) {
        refCount++;
        key += " [ref=" + ariaNode.ref + "]";
        if (options.boxes && ariaNode.box && ariaNode.box.rect) {
          const r = ariaNode.box.rect;
          key += " [box=" + Math.round(r.left + offX) + "," + Math.round(r.top + offY) + "," + Math.round(r.width) + "," + Math.round(r.height) + "]";
        }
        if (renderCursorPointer && showsPointerCursor(ariaNode)) key += " [cursor=pointer]";
      }
      if (depthCut) key += " [\u2026]"; // children hidden by opts.depth; scope into this ref to see them
      return key;
    };
    const visit = (ariaNode, indent, renderCursorPointer, level) => {
      const atDepthLimit = !!maxDepth && level >= maxDepth;
      const children = atDepthLimit ? ariaNode.children.filter(c => typeof c === "string") : ariaNode.children;
      const depthCut = atDepthLimit && children.length !== ariaNode.children.length;
      const escapedKey = indent + "- " + yamlEscapeKeyIfNeeded(createKey(ariaNode, renderCursorPointer, depthCut));
      const propKeys = Object.keys(ariaNode.props);
      const singleInlinedTextChild = children.length === 1 && typeof children[0] === "string" && !propKeys.length ? children[0] : undefined;
      if (ariaNode.role === "iframe" && ariaNode.ref) {
        const r = ariaNode.box && ariaNode.box.rect;
        const el = ariaNode.element;
        let origin = [offX, offY];
        if (r) {
          // content-box origin: border (clientLeft/Top) + padding
          const cs = getElementComputedStyle(el);
          const padL = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
          const padT = cs ? parseFloat(cs.paddingTop) || 0 : 0;
          origin = [Math.round(r.left + offX + (el.clientLeft || 0) + padL), Math.round(r.top + offY + (el.clientTop || 0) + padT)];
        }
        iframes.push({ ref: ariaNode.ref, line: lines.length, origin });
      }
      if (!children.length && !propKeys.length) {
        lines.push(escapedKey);
      } else if (singleInlinedTextChild !== undefined) {
        lines.push(escapedKey + ": " + yamlEscapeValueIfNeeded(singleInlinedTextChild));
      } else {
        lines.push(escapedKey + ":");
        for (const name of propKeys) lines.push(indent + "  - /" + name + ": " + yamlEscapeValueIfNeeded(ariaNode.props[name]));
        const childIndent = indent + "  ";
        const inCursorPointer = renderCursorPointer && providesPointerCursor(ariaNode);
        for (const child of children) {
          if (typeof child === "string") visitText(child, childIndent);
          else visit(child, childIndent, renderCursorPointer && !inCursorPointer, level + 1);
        }
      }
    };
    for (const nodeToRender of nodesToRender) {
      if (typeof nodeToRender === "string") visitText(nodeToRender, "");
      else visit(nodeToRender, "", true, 1);
    }
    return { lines, iframes, refCount };
  }

  function resolveScope(scope) {
    if (!scope) return document.body || document.documentElement;
    if (/^(?:f\d+)?e\d+$/.test(scope)) {
      const el = refElement(scope);
      if (!el) throw new Error('Ref "' + scope + '" is stale or unknown. Take a new page.snapshot() and use a fresh ref.');
      return el;
    }
    const el = document.querySelector(scope);
    if (!el) throw new Error('snapshot scope "' + scope + '" matched no element.');
    return el;
  }

  function snapshot(opts) {
    opts = opts || {};
    refState.frameKey = opts.refPrefix || "";
    const root = resolveScope(opts.scope);
    const tree = generateAriaTree(root, opts);
    if (opts.interactive) pruneInteractive(tree.root);
    const rendered = renderAriaTree(tree, opts);
    let lines = rendered.lines;
    let truncated = false;
    let droppedLines = 0;
    // Safety valve only: the host does the real maxChars truncation on the combined output.
    const hardCap = opts.maxChars > 0 ? opts.maxChars * 4 : 0;
    if (hardCap) {
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        total += lines[i].length + 1;
        if (total > hardCap) {
          droppedLines = lines.length - i;
          lines = lines.slice(0, i);
          truncated = true;
          break;
        }
      }
    }
    const iframes = rendered.iframes.filter(f => f.line < lines.length);
    return { yaml: lines.join("\n"), refs: rendered.refCount, truncated, droppedLines, iframes };
  }


  // Scoped semantic guards adapted from jev-ultrafast. A changing sidebar or
  // animation must not invalidate an unrelated click. Document/form state,
  // target identity, meaning and surrounding context still have to match.
  const jevIds = refState.jevIds || (refState.jevIds = new WeakMap());
  function jevIdentity(e) {
    if (!jevIds.has(e)) jevIds.set(e, refState.jevNext = (refState.jevNext || 0) + 1);
    return jevIds.get(e);
  }
  function jevPageKey() {
    return JSON.stringify([refState.documentId, location.href, scrollX, scrollY, innerWidth, innerHeight,
      [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')]
        .filter(e => !["password","file","hidden"].includes(e.type))
        .map(e => [jevIdentity(e), e.value ?? (e.textContent ? e.innerText : ""), e.checked, e.selectedIndex, e.disabled, e.readOnly])]);
  }
  // Some forms put a checkbox's caption beside it without a <label>. Read
  // only adjacent inline text, stopping at another control or a row boundary.
  // Accessible names remain authoritative; do not borrow an entire form's text.
  function jevAdjacentCaption(e) {
    if (!['checkbox','radio','switch'].includes(getAriaRole(e))) return '';
    for (const direction of ['nextSibling','previousSibling']) {
      const parts = [];
      for (let n = e[direction], count = 0; n && count++ < 8; n = n[direction]) {
        let text = '';
        if (n.nodeType === Node.TEXT_NODE) text = n.textContent || '';
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if (!['SPAN','B','STRONG','EM','I','SMALL'].includes(n.tagName) ||
              n.matches('a,button,input,select,textarea,[role],[tabindex],[onclick]') ||
              n.querySelector('a,button,input,select,textarea,[role],[tabindex],[onclick]') ||
              !n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) ||
              n.closest('[inert],[aria-hidden="true"]')) break;
          text = n.innerText || '';
        } else continue;
        if (direction === 'nextSibling') parts.push(text); else parts.unshift(text);
      }
      const text = normalizeWhiteSpace(parts.join(' '));
      if (text) return text.slice(0,200);
    }
    return '';
  }
  function jevTargetKey(e) {
    if (!e?.isConnected || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
    const scope = e.closest('label,fieldset,form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    // A navigation link is identified by its own name, resolved URL and scope
    // identity. Video timers elsewhere in its article are not its semantics.
    const navigation = e.tagName === 'A' && /^https?:/.test(e.href);
    const strictContext = !navigation || scope?.matches('label,fieldset,form,dialog,[role="dialog"]');
    return JSON.stringify([jevIdentity(e), getAriaRole(e), normalizeWhiteSpace(getElementAccessibleName(e, false) || ""), jevAdjacentCaption(e),
      e.value ?? (e.isContentEditable ? (e.textContent ? e.innerText : "") : null), e.type, e.checked, e.selectedIndex, e.readOnly,
      e.matches(':disabled'), getAriaDisabled(e), e.getAttribute('aria-readonly'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'), e.getAttribute('href'), navigation ? e.href : null,
      e.getAttribute('class'),
      e.tagName === 'SELECT' ? [...e.options].map(o => [o.label,o.value,o.disabled,!!o.closest('optgroup[disabled]')]) : null,
      scope && scope !== document.body ? [jevIdentity(scope), strictContext ? (scope.innerText || '').slice(0,6000) : null] : null]);
  }
  function jevTarget(ref, pageKey, targetKey, clicking = false) {
    const e = refElement(ref);
    if (jevPageKey() !== pageKey || jevTargetKey(e) !== targetKey || !e ||
        e.matches(':disabled') || getAriaDisabled(e) || e.closest('[inert],[aria-hidden="true"]')) return null;
    const r = e.getBoundingClientRect();
    const x = Math.max(0,r.left) + (Math.min(innerWidth,r.right)-Math.max(0,r.left))/2;
    const y = Math.max(0,r.top) + (Math.min(innerHeight,r.bottom)-Math.max(0,r.top))/2;
    let top = document.elementFromPoint(x,y);
    while (top?.shadowRoot) {
      const next = top.shadowRoot.elementFromPoint(x,y);
      if (!next || next === top) break;
      top = next;
    }
    return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      top && (e === top || e.contains(top)) && (!clicking || jevHit(e, true)) ? e : null;
  }

  function jevHit(e, clicking = false) {
    const r = e.getBoundingClientRect();
    const left = Math.max(0,r.left), right = Math.min(innerWidth,r.right);
    const top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
    if (right <= left || bottom <= top) return false;
    const x = (left+right)/2, y = (top+bottom)/2;
    let hit = document.elementFromPoint(x,y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint(x,y);
      if (!next || next === hit) break;
      hit = next;
    }
    if (!hit || (e !== hit && !e.contains(hit))) return false;
    // A click on an article's center must not activate a nested video/button.
    // Offer the actual nested control or a permalink instead of its container.
    if (clicking) for (let child = hit; child && child !== e; child = child.parentElement || child.getRootNode().host) {
      if (child.matches('video,audio,iframe,frame') || child.isContentEditable || INTERACTIVE_ROLES.has(getAriaRole(child))) return false;
    }
    return true;
  }

  // Structured, viewport-limited action table for Jev. Uses the same accessible
  // names and ref registry as normal snapshots, in the isolated realm.
  function jevSnapshot() {
    refState.frameKey = "";
    if (!refState.documentId) refState.documentId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now() + ":" + Math.random();
    const elements = [], texts = [], disabledControls = [];
    let unsupportedFrames = false, truncated = false;
    const roots = [document], nodes = [];
    for (let i=0;i<roots.length;i++) for (const e of roots[i].querySelectorAll('*')) {
      nodes.push(e);
      if (e.shadowRoot) roots.push(e.shadowRoot);
    }
    const onscreen = e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
        !closestCrossShadow(e, '[inert],[aria-hidden="true"]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    };
    // Reuse the accessible-name/ref implementation only for actionable controls,
    // not a full accessibility tree for every wrapper and offscreen article.
    beginAriaCaches();
    try {
      for (const e of nodes) {
        if (!onscreen(e)) continue;
        if (e.matches('iframe,frame')) { unsupportedFrames = true; continue; }
        const role = getAriaRole(e) || 'generic';
        // CSS-only click affordances also occur on divs with addEventListener.
        // Keep the ancestor that owns the pointer cursor, not all its children.
        const parent = e.parentElement || e.getRootNode().host;
        // A list can inherit its cursor from a menu, but each list item is a
        // separate choice. Do not promote all nested spans to duplicate targets.
        const pointerInherited = role !== 'listitem' && !!parent && getElementComputedStyle(parent)?.cursor === 'pointer';
        if (!INTERACTIVE_ROLES.has(role) && !e.isContentEditable && !e.hasAttribute('onclick') &&
            !hasTabIndex(e) && (pointerInherited || getElementComputedStyle(e)?.cursor !== 'pointer')) continue;
        const type = (e.type || "").toLowerCase();
        if (type === 'password' || type === 'file') continue;
        const node = toAriaNode(e, {}, pointerInherited);
        const label = node && (node.name || e.getAttribute("placeholder") || e.getAttribute("title") || jevAdjacentCaption(e) || normalizeWhiteSpace(e.innerText || '').slice(0, 200) || node.role);
        if (node?.ref && (getAriaDisabled(e) || e.matches(':disabled')) && disabledControls.length < 150) {
          disabledControls.push({ref: node.ref, role: node.role, label});
        }
        if (node?.ref && !getAriaDisabled(e) && !e.matches(":disabled") && jevHit(e)) {
          const operations = [];
          const editable = (e.tagName === "INPUT" && !["hidden","password","checkbox","radio","file","submit","reset","button","image"].includes(type)) || e.tagName === "TEXTAREA" || e.isContentEditable;
          if (editable && !e.readOnly && e.getAttribute("aria-readonly") !== "true") operations.push("TYPE_TEXT");
          let options;
          if (e.tagName === "SELECT" && !e.multiple) {
            options = [...e.options].map((o, i) => ({ index: String(i), label: o.label, value: o.value, disabled: o.disabled || !!o.closest("optgroup[disabled]") }))
              .filter(o => !o.disabled).map(({disabled, ...o}) => o);
            if (options.length) operations.push("SELECT");
          } else if (type !== "password" && type !== "file" && node.role !== "iframe" && isInteractiveNode(node) && !e.isContentEditable && jevHit(e, true)) operations.push("CLICK");
          // An article with an explicit permalink has a precise navigation
          // target; its large surface can route clicks to embedded media.
          if (node.role === 'article' && operations.includes('CLICK') && e.querySelector('a[href] time,a[rel~="bookmark"]')) operations.splice(operations.indexOf('CLICK'), 1);
          if (operations.length) {
            if (elements.length >= 150) truncated = true;
            else elements.push({
              ref: node.ref, role: node.role,
              label,
              // LI.value is a list ordinal, not a current form value.
              value: String(editable || e.tagName === 'SELECT' ? e.value ?? (e.textContent ? e.innerText : '') : ''), operations, options,
              checked: node.checked, expanded: node.expanded, selected: node.selected,
              focused: editable && e.getRootNode().activeElement === e || undefined,
              // Preserve observable CSS state for controls without ARIA. Do
              // not infer checked=true from a generic class such as "active".
              className: node.checked === undefined && node.selected === undefined && typeof e.className === 'string' ? e.className.slice(0, 200) : undefined,
              context: normalizeWhiteSpace((e.closest("label,fieldset,form,[role=dialog],article") || e.parentElement)?.innerText || "").slice(0, 240),
              href: e.tagName === "A" ? e.href : undefined
            });
          }
        }
      }
    } finally { endAriaCaches(); }
    // Read actual viewport text once. Aggregated article names otherwise repeat
    // the same post and video timer at each ancestor and fill the context budget.
    let textLength = 0;
    const range = document.createRange();
    for (const root of roots) {
      const walker = document.createTreeWalker(root === document ? document.body || document.documentElement : root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const value = normalizeWhiteSpace(node.textContent || ''), parent = node.parentElement;
        if (!value || !parent || closestCrossShadow(parent,'script,style,noscript,template,[inert],[aria-hidden="true"]') ||
            !parent.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
        texts.push(value); textLength += value.length + 1;
        if (textLength > 6000) { truncated = true; break; }
      }
      if (truncated && textLength > 6000) break;
    }
    const text = texts.join("\n");
    const main = document.querySelector('main,[role="main"]') || document.body || document.documentElement;
    const loading = document.readyState === "loading" || main.getAttribute('aria-busy') === 'true' ||
      [...main.querySelectorAll('[aria-busy="true"],[role="progressbar"],progress')].some(onscreen);
    const feedback = [...document.querySelectorAll('output,[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
      .filter(e => onscreen(e) && !e.closest('[inert],[aria-hidden="true"]'))
      .map(e => ({ key: refState.documentId + ':' + jevIdentity(e), text: normalizeWhiteSpace(e.innerText || '') }))
      .filter(f => f.text && f.text.length <= 1000).slice(0,20);
    // Scrolling the background while a composer/menu is open never reveals its
    // options. Keep Jev on the currently actionable surface.
    const overlay = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]')].some(onscreen);
    return { documentId: refState.documentId, url: location.href, title: document.title,
      text: text.slice(0, 6000), elements, scroll: { x: scrollX, y: scrollY, up: !overlay && scrollY > 1,
      down: !overlay && scrollY + innerHeight < Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) - 1 },
      truncated: truncated || text.length > 6000, unsupportedFrames, loading, disabledControls, feedback,
      guards: { page: jevPageKey(), targets: Object.fromEntries(elements.map(e => [e.ref, jevTargetKey(refElement(e.ref))])) } };
  }

  window.__jevBrowserUse = { jevSnapshot, jevTarget, jevHit, version: ${INPAGE_VERSION}, snapshot, ref: refElement, box: refBox };
})()`;
