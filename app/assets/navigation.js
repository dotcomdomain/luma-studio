// Most used first. The editor opens on the first one.
const photoToolOrder = ['crop', 'adjust', 'looks', 'text', 'draw'];
const videoToolOrder = ['trim', 'crop', 'playback', 'adjust', 'looks', 'text', 'draw'];
function configureNavigation(type) {
  const order = type === 'video' ? videoToolOrder : photoToolOrder;
  document.querySelectorAll('.tool-nav [data-tool]').forEach(button => {
    const index = order.indexOf(button.dataset.tool);
    button.classList.toggle('hidden', index < 0);
    button.style.order = index;
  });
  document.querySelector('.tool-nav').scrollLeft = 0;
  updateNavigation();
  requestAnimationFrame(updateNavigationFade);
}
// The tool bar scrolls sideways in portrait and becomes a vertical rail in landscape.
function navigationVertical(nav) {
  return getComputedStyle(nav).flexDirection === 'column';
}
// Fade whichever edge still has tools scrolled out of view.
function updateNavigationFade() {
  const nav = document.querySelector('.tool-nav'), vertical = navigationVertical(nav),
        pos = vertical ? nav.scrollTop : nav.scrollLeft,
        max = vertical ? nav.scrollHeight - nav.clientHeight : nav.scrollWidth - nav.clientWidth;
  nav.style.setProperty('--fade-start', pos > 2 ? '32px' : '0px');
  nav.style.setProperty('--fade-end', pos < max - 2 ? '32px' : '0px');
}
document.querySelector('.tool-nav').addEventListener('scroll', updateNavigationFade, {passive: true});
window.addEventListener('resize', () => { updateNavigationFade(); updateNavigation(); });
function updateNavigation() {
  const nav = document.querySelector('.tool-nav');
  const active = nav.querySelector('[data-tool="' + tool + '"]');
  if (!active || active.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    const edge = nav.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (navigationVertical(nav)) {
      if (item.top < edge.top) nav.scrollTop -= edge.top - item.top + 8;
      else if (item.bottom > edge.bottom) nav.scrollTop += item.bottom - edge.bottom + 8;
    } else {
      if (item.left < edge.left) nav.scrollLeft -= edge.left - item.left + 8;
      else if (item.right > edge.right) nav.scrollLeft += item.right - edge.right + 8;
    }
    updateNavigationFade();
  });
}
// The keyboard takes most of the screen; hide the editor chrome while a panel field has
// focus so the preview stays visible.
let fullViewportHeight = innerHeight, viewportWidth = innerWidth;
function updateKeyboardState() {
  if (innerWidth !== viewportWidth) { viewportWidth = innerWidth; fullViewportHeight = innerHeight; }
  fullViewportHeight = Math.max(fullViewportHeight, innerHeight);
  const field = document.activeElement?.closest?.('#toolContent textarea, #toolContent input[type=text], #toolContent input[type=number]');
  $('editor').classList.toggle('keyboard-open', !!field && innerHeight < fullViewportHeight * .8);
}
window.addEventListener('resize', updateKeyboardState);
document.addEventListener('focusin', updateKeyboardState);
document.addEventListener('focusout', () => setTimeout(updateKeyboardState, 0));
