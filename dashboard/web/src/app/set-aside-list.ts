import { Component, inject } from '@angular/core';
import { AGENTS, Store, type SetAsideItem } from './store';
import { setAsideNote } from './skill-actions';

/**
 * Personal skills that were set aside because they hid a library skill of the same name. Each can be put back.
 * Shown on the Library card and the Skills page; renders nothing when nothing is set aside. Restore only queues a change.
 */
@Component({ selector: 'af-set-aside', template: `
  @if (s.catalog()?.setAside; as items) {
    @if (items.length) {
      <section class="set-aside" aria-label="Set aside">
        <h3>Set aside</h3>
        <p class="fine">Your own skills moved out of the way. Nothing was deleted.</p>
        <ul>
          @for (i of items; track i.tool + '/' + i.name) {
            <li>
              <span><strong>{{ i.name }}</strong> <span class="fine">{{ tool(i.tool) }}</span></span>
              <span class="fine">{{ note(i) }}</span>
              @if (planned(i)) { <span class="planned-note">Will be restored when you apply</span> }
              @else { <button type="button" class="quiet tiny" (click)="s.restoreSkill(i.tool, i.name)" [disabled]="!i.restorable || s.applying()"
                              [attr.aria-label]="'Restore ' + i.name + ' for ' + tool(i.tool)">Restore</button> }
            </li>
          }
        </ul>
      </section>
    }
  }
` })
export class SetAsideList {
  s = inject(Store);
  note = setAsideNote;
  tool(id: string) { return AGENTS[id] || id; }
  planned(i: SetAsideItem) { return this.s.pendingFor('skill.restore', a => a['tool'] === i.tool && a['name'] === i.name).length > 0; }
}
