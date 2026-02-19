// Theme toggle
const toggle = document.getElementById('theme-toggle');
if (toggle) {
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const icon = toggle.querySelector('i');
    icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  }

  toggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  applyTheme(localStorage.getItem('theme') || 'dark');
}

// Navbar burger → toggle sidebar on mobile
document.querySelectorAll('.navbar-burger').forEach(el => {
  el.addEventListener('click', () => {
    const sidebar = document.getElementById(el.dataset.target);
    el.classList.toggle('is-active');
    if (sidebar) sidebar.classList.toggle('is-open');
  });
});

// Shrink navbar on scroll
let ticking = false;
window.addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(() => {
      document.body.classList.toggle('is-scrolled', window.scrollY > 50);
      ticking = false;
    });
    ticking = true;
  }
});
