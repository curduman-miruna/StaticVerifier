/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ['./src/popup/**/*.{ts,tsx,css}'],
	prefix: 'tw-',
	corePlugins: {
		preflight: false
	},
	theme: {
		extend: {}
	},
	plugins: []
};
