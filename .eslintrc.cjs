module.exports = {
	env: {
		node: true,
		es2022: true,
	},
	extends: ['eslint:recommended'],
	parserOptions: {
		ecmaVersion: 'latest',
		sourceType: 'module',
	},
	rules: {
		'no-console': 'off',
		'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		'no-await-in-loop': 'off',
		'max-len': ['warn', { code: 225 }],
		'no-param-reassign': ['error', { props: false }],
		'arrow-body-style': ['error', 'as-needed'],
		'consistent-return': 'warn',
		curly: ['error', 'all'],
		indent: ['error', 'tab'],
	},
};
