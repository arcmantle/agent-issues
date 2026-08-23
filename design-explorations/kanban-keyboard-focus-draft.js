export class KanbanKeyboardFocusDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `<section class="keyboard-focus-preview" aria-labelledby="keyboard-focus-title"><header><span class="type-label">Keyboard navigation</span><h2 id="keyboard-focus-title">Record actions</h2></header><p>Use Tab and Shift+Tab to move through the enabled controls.</p><div class="keyboard-focus-controls"><button class="keyboard-focus-control" type="button">Save changes</button><a class="keyboard-focus-control keyboard-focus-link" href="#record-details">View details</a><label class="keyboard-focus-field">Status<select class="keyboard-focus-control"><option>Todo</option><option>In progress</option><option>Done</option></select></label><button class="keyboard-focus-control" type="button" disabled>Archive issue</button></div></section>`;
	}
}

customElements.define("kanban-keyboard-focus-draft", KanbanKeyboardFocusDraft);