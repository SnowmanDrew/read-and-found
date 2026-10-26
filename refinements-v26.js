(() => {
 const field=document.getElementById('favourites');
 if(!field)return;
 function resizeFavourites(){
  if(!window.matchMedia('(max-width:600px)').matches){field.style.height='';return;}
  field.style.height='auto';
  field.style.height=Math.max(90,field.scrollHeight)+'px';
 }
 field.addEventListener('input',resizeFavourites);
 window.addEventListener('resize',resizeFavourites);
 for(const id of ['logoReset','startAgain']) document.getElementById(id)?.addEventListener('click',()=>requestAnimationFrame(resizeFavourites));
 resizeFavourites();
})();