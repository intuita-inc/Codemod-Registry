import { Project } from 'ts-morph';
import { handleSourceFile } from './index.js';
import { Context } from 'mocha';
import { deepStrictEqual } from 'node:assert';

export const transform = (
	beforeText: string,
	afterText: string,
	extension: '.js' | '.tsx',
) => {
	const project = new Project({
		useInMemoryFileSystem: true,
		skipFileDependencyResolution: true,
		compilerOptions: {
			allowJs: true,
		},
	});

	const actualSourceFile = project.createSourceFile(
		`actual${extension}`,
		beforeText,
	);
	const actual = handleSourceFile(actualSourceFile);

	const expected = project
		.createSourceFile(`expected${extension}`, afterText)
		.print();

	return {
		actual,
		expected,
	};
};

describe('next 13 upsert-client-directive', function () {
	it('should not rewrite the file', function (this: Context) {
		const beforeText = `
            'use client';

            export default function Page() {
                return null;
            }
		`;

		const { actual } = transform(beforeText, beforeText, '.tsx');
		deepStrictEqual(actual, undefined);
	});

	it("should upsert the 'use client' directive when React hooks are used", function (this: Context) {
		const beforeText = `
            import { useState } from 'react';

            export default function Page() {
                const [x, setX] = useState('');

                return x;
            }
		`;

		const afterText = `
            'use client';
            import { useState } from 'react';

            export default function Page() {
                const [x, setX] = useState('');

                return x;
            }
        `;

		const { actual, expected } = transform(beforeText, afterText, '.tsx');
		deepStrictEqual(actual, expected);
	});

	it("should not upsert the 'use client' directive when fetch is used", function (this: Context) {
		const beforeText = `
            export default async function Page() {
                return fetch('http://example.com);
            }
		`;

		const { actual } = transform(beforeText, beforeText, '.tsx');
		deepStrictEqual(actual, undefined);
	});

	it("should not upsert the 'use client' directive when fetch is used", function (this: Context) {
		const beforeText = `
            export default async function Page() {
                return fetch('http://example.com);
            }
		`;

		const { actual } = transform(beforeText, beforeText, '.tsx');
		deepStrictEqual(actual, undefined);
	});

	it("should upsert the 'use client' directive when an event handler is used", function (this: Context) {
		const beforeText = `
            export default async function Page() {
                return <div onClick={null}>
                    TEST
                </div>;
            }
		`;

		const afterText = `
            'use client';
            export default async function Page() {
                return <div onClick={null}>
                    TEST
                </div>;
            }
        `;

		const { actual, expected } = transform(beforeText, afterText, '.tsx');
		deepStrictEqual(actual, expected);
	});
});
