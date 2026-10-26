(() => {
  const field = document.getElementById('favourites');
  const counter = document.querySelector('.character-hint');
  if (!field || !counter) return;
  const update = () => counter.classList.toggle('is-visible',field.value.length >= 1050);
  field.addEventListener('input',update);
  document.getElementById('useExample')?.addEventListener('click',()=>requestAnimationFrame(update));
  update();
})();
