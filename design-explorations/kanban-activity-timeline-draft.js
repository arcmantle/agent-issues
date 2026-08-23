import "./kanban-activity-event-draft.js";

const defaultEvents = [
	{
		time: "Today, 10:24",
		summary: "R. Lee moved ISS-318 to In progress",
		detail: "Keep pending edits stable through snapshot refresh",
		tone: "accent"
	},
	{
		time: "Today, 09:46",
		summary: "ADR-014 was accepted",
		detail: "Serve the board through a detached local runtime"
	},
	{
		time: "Yesterday, 16:12",
		summary: "ISS-319 was marked blocked",
		detail: "Waiting on the local server lifecycle decision",
		tone: "warning"
	}
];

function eventMarkup({ time, summary, detail, tone }) {
	const toneAttribute = tone ? ` tone="${tone}"` : "";
	return `<kanban-activity-event-draft time="${time}" summary="${summary}" detail="${detail}"${toneAttribute}></kanban-activity-event-draft>`;
}

export class KanbanActivityTimelineDraft extends HTMLElement {
	static get observedAttributes() {
		return ["empty", "label"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const label = this.getAttribute("label") ?? "Initiative activity";
		const content = this.hasAttribute("empty")
			? "<p class=\"activity-timeline-empty\">No activity has been recorded for this initiative.</p>"
			: defaultEvents.map(eventMarkup).join("");
		this.innerHTML = `<section class="activity-timeline" aria-label="${label}">${content}</section>`;
	}
}

customElements.define("kanban-activity-timeline-draft", KanbanActivityTimelineDraft);