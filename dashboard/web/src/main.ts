import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app/app';
import { Board } from './app/board';
import { Library } from './app/library';

bootstrapApplication(App, { providers: [provideHttpClient(), provideRouter([
  { path: '', component: Board, title: 'Wiring · agentforge' },
  { path: 'library', component: Library, title: 'Skills · agentforge' },
  { path: '**', redirectTo: '' },
])] }).catch(console.error);
