import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      component: () => import('@/views/LoginView.vue'),
      meta: { requiresAuth: false },
      name: 'login',
      path: '/login',
    },
    {
      component: () => import('@/views/RedfishExample.vue'),
      meta: { requiresAuth: true },
      name: 'dashboard',
      path: '/',
    },
  ],
});

router.beforeEach((to) => {
  const authStore = useAuthStore();

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    return { name: 'login' };
  }

  if (to.name === 'login' && authStore.isAuthenticated) {
    return { name: 'dashboard' };
  }
});

export default router;
