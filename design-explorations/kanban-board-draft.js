import "./kanban-column-draft.js";
import "./kanban-card-draft.js";

export class KanbanBoardDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `
			<section class="kanban-board" aria-label="Issue Kanban board">
				<kanban-column-draft title="Todo" count="03"><kanban-card-draft reference="ISS-322" title="Define the board-server write contract" category="High" detail="2 blockers" status="Todo" blockers="2" relationships="3"></kanban-card-draft><kanban-card-draft reference="ISS-327" title="Render a compact issue card" category="Product" detail="PRD 26" status="Todo" relationships="1"></kanban-card-draft></kanban-column-draft>
				<kanban-column-draft title="In progress" count="02"><kanban-card-draft reference="ISS-318" title="Keep pending edits stable through snapshot refresh" category="Technical" detail="R. Lee" status="In progress" owner="R. Lee"></kanban-card-draft><kanban-card-draft reference="ISS-320" title="Add separate relation sections to the overlay" category="Product" detail="1 comment" status="In progress" relationships="1"></kanban-card-draft></kanban-column-draft>
				<kanban-column-draft title="Blocked" count="01"><kanban-card-draft reference="ISS-319" title="Start the detached Kanban server" category="High" detail="ISS-186" status="Blocked" blockers="1" relationships="1" due="Overdue" blocked></kanban-card-draft></kanban-column-draft>
				<kanban-column-draft title="Done" count="02"><kanban-card-draft reference="ISS-312" title="Specify optimistic mutation recovery" category="Design" detail="Complete" status="Done"></kanban-card-draft></kanban-column-draft>
			</section>
		`;
	}
}

customElements.define("kanban-board-draft", KanbanBoardDraft);
