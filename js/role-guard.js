/**
 * Role Guard - Client-side role validation and page protection
 * Include this script on role-specific pages to prevent unauthorized access
 */

(function() {
    'use strict';
    
    // Page to role mapping
    const PAGE_ROLES = {
        '/farmer.html': 'farmer',
        '/farmer': 'farmer',
        '/consumer.html': 'consumer', 
        '/consumer': 'consumer',
        '/organisation.html': 'organization',
        '/organisation': 'organization',
        '/admin.html': 'admin',
        '/admin': 'admin'
    };
    
    // Role to default page mapping
    const ROLE_PAGES = {
        'farmer': '/farmer.html',
        'consumer': '/consumer.html',
        'organization': '/organisation.html',
        'admin': '/admin.html'
    };
    
    // Get current page and required role
    const currentPath = window.location.pathname;
    const requiredRole = PAGE_ROLES[currentPath];
    
    // Only run on protected pages
    if (!requiredRole) {
        return;
    }
    
    console.log('[RoleGuard] Validating access to', currentPath, 'requiring role:', requiredRole);
    
    // Function to redirect to appropriate page
    function redirectToRolePage(userRole) {
        const correctPage = ROLE_PAGES[userRole] || '/consumer.html';
        if (correctPage !== currentPath) {
            console.log('[RoleGuard] Redirecting', userRole, 'user from', currentPath, 'to', correctPage);
            window.location.replace(correctPage);
        }
    }
    
    // Function to redirect to login
    function redirectToLogin() {
        console.log('[RoleGuard] Unauthorized access, redirecting to login');
        window.location.replace('/login.html');
    }
    
    // Validate role on page load
    async function validateRole() {
        try {
            // Get token from cookies or sessionStorage
            let token = getCookie('authToken') || sessionStorage.getItem('idToken');
            
            if (!token) {
                console.log('[RoleGuard] No authentication token found');
                redirectToLogin();
                return;
            }
            
            // Validate role with server
            const response = await fetch('/api/auth/validate-role', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });
            
            if (!response.ok) {
                console.log('[RoleGuard] Role validation failed:', response.status);
                redirectToLogin();
                return;
            }
            
            const data = await response.json();
            const userRole = data.role;
            
            console.log('[RoleGuard] User role:', userRole, 'Required:', requiredRole);
            
            // Check if user has correct role for this page
            if (userRole !== requiredRole) {
                console.log('[RoleGuard] Role mismatch - redirecting to correct page');
                redirectToRolePage(userRole);
                return;
            }
            
            // Update sessionStorage with current role to prevent confusion
            sessionStorage.setItem('role', userRole);
            sessionStorage.setItem('uid', data.uid);
            sessionStorage.setItem('email', data.email);
            
            console.log('[RoleGuard] Access granted for', userRole, 'user');
            
        } catch (error) {
            console.error('[RoleGuard] Validation error:', error);
            redirectToLogin();
        }
    }
    
    // Helper function to get cookie value
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }
    
    // Run validation immediately and on focus (when user returns to tab)
    validateRole();
    
    // Re-validate when user returns to the page/tab
    window.addEventListener('focus', validateRole);
    
    // Re-validate periodically (every 30 seconds)
    setInterval(validateRole, 30000);
    
    console.log('[RoleGuard] Role guard initialized for', currentPath);
    
})();