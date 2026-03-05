(function () {
  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }

  function updateThemeIcon(theme) {
    var iconDark = document.getElementById('icon-dark');
    var iconLight = document.getElementById('icon-light');
    if (iconDark) iconDark.style.display = theme === 'dark' ? '' : 'none';
    if (iconLight) iconLight.style.display = theme === 'light' ? '' : 'none';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var theme = localStorage.getItem('theme') || 'dark';
    applyTheme(theme);

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    updateThemeIcon(theme);

    var toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var current = localStorage.getItem('theme') || 'dark';
        var next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        updateThemeIcon(next);
      });
    }

    var sidebarTriggers = document.querySelectorAll('[data-target="sidebar"]');
    var sidebar = document.getElementById('sidebar');
    sidebarTriggers.forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        if (sidebar) {
          sidebar.classList.toggle('is-open');
        }
      });
    });
  });
})();
