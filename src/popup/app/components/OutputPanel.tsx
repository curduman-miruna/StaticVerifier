type OutputPanelProps = {
	text: string;
};

export function OutputPanel({ text }: OutputPanelProps) {
	return (
		<section className="results">
			<h2>Output</h2>
			<pre>{text}</pre>
		</section>
	);
}
