import { LitElement } from 'lit';

export abstract class LightElement extends LitElement {
	protected override createRenderRoot(): HTMLElement {
		return this;
	}
}
