/**
 * Role Guard - Client-side role validation and page protection.
 * Reads token from localStorage (persistent across reloads).
 */

(function () {
  'use strict';

  const PAGE_ROLES = {
    '/farmer.html': 'farmer',
    '/farmer':      'farmer',
    '/consumer.html': 'consumer',
    '/consumer':      'consumer',
    '/organisation.html': 'organization',
    '/organisation':      'organization',
    '/admin.html': 'admin',
    '/admin':      'admin',
  };

  const ROLE_PAGES = {
    farmer:       '/farmer',
    consumer:     '/consumer',
    organization: '/organisation',
    admin:        '/admin',
  };

  const currentPath = window.location.pathname;
  const requiredRole = PAGE_ROLES[currentPath];
  if (!requiredRole) return;

  function redirectToRolePage(userRole) {
    const page = ROLE_PAGES[userRole];
    if (!page) {
      // unknown role — go to login
      window.location.replace('/login');
      return;
    }
    if (page !== currentPath) {
      window.location.replace(page);
    }
  }

  function redirectToLogin() {
    window.location.replace('/login');
  }

  // Get token — localStorage persists across reloads/tabs
  function getToken() {
    return localStorage.getItem('idToken')
      || sessionStorage.getItem('idToken')
      || null;
  }

  let _lastValidated = 0;
  let _validating    = false;

  async function validateRole(force) {
    if (_validating) return;
    const now = Date.now();
    // Throttle: don't re-validate more than once every 20 seconds unless forced
    if (!force && now - _lastValidated < 20000) return;
    _validating = true;
    try {
      const token = getToken();
      if (!token) {
        redirectToLogin();
        return;
      }

      const response = await fetch('/api/auth/validate-role', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token },
        credentials: 'include',
      });

      if (response.status === 401) {
        // Token expired or invalid — clear storage and redirect
        localStorage.removeItem('idToken');
        localStorage.removeItem('user');
        sessionStorage.removeItem('idToken');
        sessionStorage.removeItem('user');
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        // Server error — don't log out, just skip this cycle
        return;
      }

      const data = await response.json();
      const userRole = data.role;

      // Persist fresh role/uid in localStorage
      localStorage.setItem('role', userRole);
      localStorage.setItem('uid', data.uid);
      localStorage.setItem('email', data.email || '');
      sessionStorage.setItem('role', userRole);

      if (userRole !== requiredRole) {
        redirectToRolePage(userRole);
        return;
      }

      _lastValidated = Date.now();
    } catch (err) {
      // Network error — don't log out, user might be offline temporarily
      console.warn('[RoleGuard] Network error during validation, skipping:', err.message);
    } finally {
      _validating = false;
    }
  }

  // Run immediately on page load
  validateRole(true);

  // Re-validate when user returns to the tab (not on every focus, throttled)
  window.addEventListener('focus', () => validateRole(false));

  // Periodic check every 5 minutes (not 30 seconds — reduces server load)
  setInterval(() => validateRole(false), 5 * 60 * 1000);

})();
