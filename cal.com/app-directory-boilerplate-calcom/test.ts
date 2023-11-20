import { Context } from 'mocha';
import { deepStrictEqual, ok } from 'node:assert';
import { DirectoryJSON, Volume, createFsFromVolume } from 'memfs';
import {
	FileSystemManager,
	UnifiedFileSystem,
	buildApi,
	executeFilemod,
} from '@intuita-inc/filemod';
import { repomod } from './index.js';
import tsmorph from 'ts-morph';

const transform = async (json: DirectoryJSON) => {
	const volume = Volume.fromJSON(json);

	const fileSystemManager = new FileSystemManager(
		// @ts-expect-error type convergence
		volume.promises.readdir,
		volume.promises.readFile,
		volume.promises.stat,
	);
	const unifiedFileSystem = new UnifiedFileSystem(
		// @ts-expect-error type convergence
		createFsFromVolume(volume),
		fileSystemManager,
	);

	const api = buildApi<{
		tsmorph: typeof tsmorph;
	}>(
		unifiedFileSystem,
		() => ({
			tsmorph,
		}),
		'/',
	);

	return executeFilemod(api, repomod, '/', {}, {});
};

describe('cal.com app-directory-boilerplate-calcom', function () {
	it('should build correct files', async function (this: Context) {
		const externalFileCommands = await transform({
			'/opt/project/pages/a/index.tsx': 'TODO content',
			'/opt/project/pages/a/b.tsx': `
			import { getLayout } from './getLayout';
			export default function B(props) {
				return <Component />;
			}
			B.getLayout = getLayout;
			`,
			'/opt/project/pages/a/[b]/c.tsx': `
			export const getServerSideProps = (ctx) => {
				return null;
			}
			export default function C(props) {
				return <Component />;
			}
			`,
			'/opt/project/pages/a/d.tsx': `
			export const getStaticProps = (ctx) => {
				return null;
			}
			export default function C(props) {
				return <Component />;
			}
			`,
		});

		deepStrictEqual(externalFileCommands.length, 8);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(shared-page-wrapper)/(no-layout)/a/page.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/index.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(shared-page-wrapper)/(layout)/a/b/page.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/b.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(individual-page-wrapper)/a/[b]/c/page.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/[b]/c.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(individual-page-wrapper)/a/d/page.tsx',
			),
		);

		ok(
			externalFileCommands.some(
				(command) =>
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/d.tsx',
			),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(shared-page-wrapper)/(no-layout)/a/page.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						import Page from "@pages/a/index";
						import { _generateMetadata } from "app/_utils";

						export const generateMetadata = async () => await _generateMetadata(() => "", () => "");
						export default Page;
					`.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/index.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						'use client';
						TODO content
						`.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(shared-page-wrapper)/(layout)/a/b/page.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						import Page from "@pages/a/b";
						import { _generateMetadata } from "app/_utils";
						
						export const generateMetadata = async () => await _generateMetadata(() => "", () => "");
						export default Page;
					`.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/b.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						'use client';
						import { getLayout } from './getLayout';
						export default function B(props) {
							return <Component />;
						}
						B.getLayout = getLayout;
						`.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				const expected = `
					import OldPage from "@pages/a/[b]/c";
					import { _generateMetadata } from "app/_utils";
					import type { Params } from "next/dist/shared/lib/router/utils/route-matcher";
					import PageWrapper from "@components/PageWrapperAppDir";
					import { headers } from "next/headers";
					

					export const generateMetadata = async () => await _generateMetadata(() => "", () => "");
					
					type PageProps = Readonly<{
						params: Params;
					}>;

					const Page = ({ params }: PageProps) => {
						const h = headers();
						const nonce = h.get("x-nonce") ?? undefined;
						
						return (
							<PageWrapper requiresLicense={false} nonce={nonce} themeBasis={null}>
								<OldPage />
							</PageWrapper>
						);
					};
					
					export default Page;`;

				return (
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(individual-page-wrapper)/a/[b]/c/page.tsx' &&
					command.data.replace(/\W/gm, '') ===
						expected.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/[b]/c.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						'use client';
						export const getServerSideProps = (ctx) => {
							return null;
						}
						export default function C(props) {
							return <Component />;
						}
						`.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				const expected = `
					import OldPage from "@pages/a/d";
					import { _generateMetadata } from "app/_utils";
					import type { Params } from "next/dist/shared/lib/router/utils/route-matcher";
					import PageWrapper from "@components/PageWrapperAppDir";
					import { headers } from "next/headers";
					

					export const generateMetadata = async () => await _generateMetadata(() => "", () => "");
					
					type PageProps = Readonly<{
						params: Params;
					}>;

					const Page = ({ params }: PageProps) => {
						const h = headers();
						const nonce = h.get("x-nonce") ?? undefined;
						
						return (
							<PageWrapper requiresLicense={false} nonce={nonce} themeBasis={null}>
								<OldPage />
							</PageWrapper>
						);
					};
					
					export default Page;`;
				return (
					command.kind === 'upsertFile' &&
					command.path ===
						'/opt/project/app/future/(individual-page-wrapper)/a/d/page.tsx' &&
					command.data.replace(/\W/gm, '') ===
						expected.replace(/\W/gm, '')
				);
			}),
		);

		ok(
			externalFileCommands.some((command) => {
				return (
					command.kind === 'upsertFile' &&
					command.path === '/opt/project/pages/a/d.tsx' &&
					command.data.replace(/\W/gm, '') ===
						`
						'use client';
						export const getStaticProps = (ctx) => {
							return null;
						}
						export default function C(props) {
							return <Component />;
						}
						`.replace(/\W/gm, '')
				);
			}),
		);
	});
});
