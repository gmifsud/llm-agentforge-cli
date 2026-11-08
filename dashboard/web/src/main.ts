import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app/app';
import { Sources } from './app/sources';
import { Skills } from './app/skills';
import { Projects } from './app/projects';

bootstrapApplication(App, { providers: [provideHttpClient(), provideRouter([
  { path: '', redirectTo: 'sources', pathMatch: 'full' },
  { path: 'sources', component: Sources, title: 'Sources · Agent Forge' },
  { path: 'skills', component: Skills, title: 'Skills · Agent Forge' },
  { path: 'projects', component: Projects, title: 'Projects · Agent Forge' },
  { path: '**', redirectTo: 'sources' },
])] }).catch(console.error);
