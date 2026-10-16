import { Component } from '@angular/core';
import { RadarMap } from './radar/radar-map';

@Component({
  selector: 'app-root',
  imports: [RadarMap],
  template: '<app-radar-map></app-radar-map>',
  styles: [':host { display: block; height: 100vh; } app-radar-map { display: block; height: 100%; }']
})
export class App { }
