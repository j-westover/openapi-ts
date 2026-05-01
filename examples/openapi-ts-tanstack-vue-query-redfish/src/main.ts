import './assets/main.css';

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { configureRedfishClient } from './client-setup';
import router from './router';

const app = createApp(App);
const queryClient = new QueryClient();

app.use(createPinia());
app.use(router);
app.use(VueQueryPlugin, { queryClient });

configureRedfishClient({ queryClient, router });

app.mount('#app');
