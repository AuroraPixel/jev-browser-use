/** Runs inside the snapshot's isolated-world closure. Never exports backing values. */
export const PICKER_HELPERS = String.raw`
  const pickerEdits = refState.pickerEdits || (refState.pickerEdits = new WeakMap());
  function jevBackingField(e) {
    if (e.tagName !== 'INPUT' || ['hidden','password','file'].includes(e.type)) return null;
    const stems = [e.id, e.name].filter(Boolean).map(s => s.replace(/(?:[_-]?(?:text|name|label|display))$/i, '').toLowerCase())
      .filter((s, i) => s && s !== [e.id, e.name].filter(Boolean)[i].toLowerCase());
    if (!stems.length) return null;
    for (let parent=e.parentElement, depth=0; parent && parent!==document.body && depth<2; parent=parent.parentElement, depth++) {
      const matches = [...parent.querySelectorAll('input[type="hidden"]')].filter(h =>
        [h.id,h.name].some(s => s && stems.includes(s.toLowerCase())));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return null;
  }
  function jevIsPicker(e) {
    return e.tagName === 'INPUT' && (!!jevBackingField(e) || getAriaRole(e)==='combobox' ||
      ['list','both'].includes(e.getAttribute('aria-autocomplete')) || e.getAttribute('aria-haspopup')==='listbox');
  }
  function jevFieldCaption(e) {
    if (!['INPUT','TEXTAREA','SELECT'].includes(e.tagName)) return '';
    for (let parent=e.parentElement, depth=0; parent && parent!==document.body && depth<2; parent=parent.parentElement, depth++) {
      if (parent.querySelectorAll('input:not([type="hidden"]),textarea,select').length !== 1) break;
      const labels = [...parent.querySelectorAll('label')].filter(l => !l.htmlFor && !l.querySelector('input,textarea,select') &&
        l.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !l.closest('[inert],[aria-hidden="true"]'));
      if (labels.length === 1) return normalizeWhiteSpace(labels[0].innerText || '').slice(0,200);
    }
    return '';
  }
  function jevBeginEdit(e, value) {
    if (!jevIsPicker(e)) return;
    const backing = jevBackingField(e);
    pickerEdits.set(e, { requested:value, original:e.value, backing,
      token:backing?.value, choice:false, committed:null });
    return !!backing;
  }
  function jevSelectionPending(e) {
    const edit = pickerEdits.get(e);
    if (!edit) return false;
    if (!edit.backing) return e.getAttribute('aria-expanded') === 'true';
    const backing = jevBackingField(e);
    if (!backing || backing !== edit.backing || !backing.isConnected) return true;
    if (edit.committed) return e.value !== edit.committed.value || backing.value !== edit.committed.token;
    // The submitted identity must change with a changed display value. An
    // unchanged identity is valid only when the same original option was chosen.
    const changed = backing.value && backing.value !== edit.token;
    const reselected = edit.choice && e.value === edit.original && e.value === edit.requested && !!backing.value;
    if (e.value && (changed || reselected)) {
      edit.committed = { value:e.value, token:backing.value };
      return false;
    }
    return true;
  }
  function jevPickerOption(field, target, label) {
    if (!target || target === field || target.matches('input,textarea,select')) return false;
    const controls = (field.getAttribute('aria-controls') || field.getAttribute('aria-owns') || '').split(/\s+/);
    // Explicitly associated options may use a full name for an abbreviation
    // typed into the field; let Jev choose among those observed options.
    if (controls.some(id => id && field.getRootNode().getElementById(id)?.contains(target))) return true;
    const wanted = normalizeWhiteSpace(field.value || '');
    const name = normalizeWhiteSpace(target.getAttribute('title') || label || target.innerText || '');
    if (!wanted || !(name === wanted || name.startsWith(wanted + ' '))) return false;
    if (!jevBackingField(field) && !target.closest('[role="listbox"]')) return false;
    const a = field.getBoundingClientRect(), b = target.getBoundingClientRect();
    // Legacy menus without ARIA must be adjacent to their input, have an actual
    // click affordance, and name the typed choice. Unrelated matching links fail.
    return (getAriaRole(target)==='option' || target.tagName==='LI' || getElementComputedStyle(target)?.cursor==='pointer') &&
      b.right > a.left && b.left < a.right + 40 && b.bottom > a.top - 360 && b.top < a.bottom + 360;
  }
  function jevBeforeChoice(target) {
    const roots = [document];
    for (let i=0;i<roots.length;i++) for (const field of roots[i].querySelectorAll('*')) {
      if (field.shadowRoot) roots.push(field.shadowRoot);
      if (field.tagName === 'INPUT') {
        const edit = pickerEdits.get(field);
        if (edit && jevSelectionPending(field) && jevPickerOption(field,target,getElementAccessibleName(target,false))) edit.choice=true;
      }
    }
  }
`;
