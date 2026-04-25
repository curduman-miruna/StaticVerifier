/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ['./src/interface/**/*.{ts,tsx,css}'],
	prefix: 'tw-',
	corePlugins: {
		preflight: false
	},
	theme: {
		extend: {}
	},
	plugins: []
};
