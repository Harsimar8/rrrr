import { bootstrapApplication } from '@angular/platform-browser';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { App } from './app/app';

(window as any).CESIUM_BASE_URL = '/cesium/';

bootstrapApplication(App, { providers: [provideBrowserGlobalErrorListeners()] })
  .catch((err) => console.error(err));
