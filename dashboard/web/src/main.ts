import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app/app';
import { Board } from './app/board';
import { Library } from './app/library';
import { Compare } from './app/compare';

bootstrapApplication(App, { providers: [provideHttpClient(), provideRouter([
  { path: '', component: Board, title: 'Wiring · agentforge' },
  { path: 'library', component: Library, title: 'Skills · agentforge' },
  { path: 'compare/:name', component: Compare, title: 'Compare · agentforge' },
  { path: '**', redirectTo: '' },
])] }).catch(console.error);
