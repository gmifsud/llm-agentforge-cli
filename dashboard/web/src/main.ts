import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app/app';
import { Board } from './app/board';
import { Fleet } from './app/fleet';
import { Library } from './app/library';
import { Compare } from './app/compare';

bootstrapApplication(App, { providers: [provideHttpClient(), provideRouter([
  { path: '', component: Fleet, title: 'Fleet · agentforge' },
  // The fleet view was first shown at /fleet; a bookmark made then still arrives.
  { path: 'fleet', redirectTo: '', pathMatch: 'full' },
  // The cable map has no menu entry: it draws one project or one folder, reached from Show wiring in Fleet.
  { path: 'map', component: Board, title: 'Map · agentforge' },
  { path: 'library', component: Library, title: 'Skills · agentforge' },
  { path: 'compare/:name', component: Compare, title: 'Compare · agentforge' },
  { path: '**', redirectTo: '' },
])] }).catch(console.error);
