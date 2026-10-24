// js/town-config.js
// Small helpers shared by the input modules.

// True while the player types in a form field of the page (the map's search box): the game keys must not fire
export function isTypingInField(e) {
  return !!e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
}
