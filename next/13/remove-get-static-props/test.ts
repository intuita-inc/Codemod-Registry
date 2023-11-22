import {
	FileSystemManager,
	UnifiedFileSystem,
	buildApi,
	executeFilemod,
} from '@intuita-inc/filemod';
import jscodeshift from 'jscodeshift';
import { DirectoryJSON, Volume, createFsFromVolume } from 'memfs';
import { repomod } from './index.js';
import { Context } from 'mocha';
import assert, { deepStrictEqual } from 'node:assert';
import { transform as jscodeshiftTransform } from './index.js';

const globalOptions = {
	buildLegacyCtxUtilAbsolutePath: '/opt/project/hooks/buildLegacyCtx.tsx',
};

const transform = async (json: DirectoryJSON) => {
	const volume = Volume.fromJSON(json);

	const fileSystemManager = new FileSystemManager(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		volume.promises.readdir as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		volume.promises.readFile as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		volume.promises.stat as any,
	);
	const unifiedFileSystem = new UnifiedFileSystem(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createFsFromVolume(volume) as any,
		fileSystemManager,
	);

	const api = buildApi<{
		jscodeshift: typeof jscodeshift;
	}>(unifiedFileSystem, () => ({
		jscodeshift,
	}));

	return executeFilemod(api, repomod, '/', globalOptions, {});
};

describe('next 13 remove-get-static-props', function () {
	it('should build correct file', async function (this: Context) {
		const A_CONTENT = `
		export async function getServerSideProps(ctx) {
			const users = await promise;
			return { props: { users } };
		}

		export default function Component({ users }) {
			return users.map(user => <b>user</b>)
		}
		`;

		const [upsertBuildLegacyCtxUtilCommand, upsertFileCommand] =
			await transform(
				{
					'/opt/project/pages/a.tsx': A_CONTENT,
				},
				{},
			);

		const expectedResult = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetServerSidePropsContext } from "next";
		
		type Params = {
			[key: string]: string | string[] | undefined
		};

		type PageProps = {
				params: Params
searchParams: Params
		};

		export async function getServerSideProps(ctx) {
			const users = await promise;
			return { props: { users } };
		}

		async function getData(ctx: GetServerSidePropsContext) {
			const users = await promise;
			return { users };
		}
			
		export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
			const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
			const { users } = await getData(legacyCtx);

			return users.map(user => <b>user</b>)
		}
		`;

		deepStrictEqual(upsertBuildLegacyCtxUtilCommand?.kind, 'upsertFile');
		deepStrictEqual(
			upsertBuildLegacyCtxUtilCommand.path,
			'/opt/project/hooks/buildLegacyCtx.tsx',
		);

		deepStrictEqual(upsertFileCommand?.kind, 'upsertFile');
		deepStrictEqual(upsertFileCommand.path, '/opt/project/pages/a.tsx');

		deepStrictEqual(
			upsertFileCommand.data.replace(/\s/gm, ''),
			expectedResult.replace(/\s/gm, ''),
		);
	});

	it('should not remove anything if getStaticProps', function () {
		const INPUT = `
			export default function Component() {
	          }
	      `;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(actualOutput, undefined);
	});

	it('should create an additional function if getStaticProps is present', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;

				return { props: { users } };
			}

			export default function Component({ users }) {
				return users.map(user => <b>user</b>)
	          }
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
		type Params = {
			[key: string]: string | string[] | undefined
		};

		type PageProps = {
				params: Params
searchParams: Params
		};
		
			export async function getStaticProps() {
				const users = await promise;

				return { props: { users } };
			}

			async function getData(
				props: GetStaticPropsContext
		) {
				const users = await promise;

				return { users };
		}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {users} = await getData(legacyCtx);

				return users.map(user => <b>user</b>)
			}
			
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should create an additional function if getStaticProps returns an Identifier', function () {
		const INPUT = `
			export async function getStaticProps(context: GetStaticPropsContext) {
				const users = await promise(context.params);
				const res = { props: { users } };
				return res;
			}
			export default function Component({ users }) {
				return users.map(user => <b>user</b>)
			}
	      `;

		const OUTPUT = `
			import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
			import { headers, cookies } from "next/headers";	
			import { GetStaticPropsContext } from "next";
			import { notFound, redirect } from "next/navigation";

			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps(context: GetStaticPropsContext) {
				const users = await promise(context.params);
				const res = { props: { users } };
				return res;
			}

			const getData =  async (ctx: GetStaticPropsContext) => {
				const result = await getStaticProps(ctx);
				
				if("redirect" in result) {
						redirect(result.redirect.destination);
				}
				
				if("notFound" in result) {
						notFound();
				}
				
				return "props" in result ? result.props : {};
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {users} = await getData(legacyCtx);

				return users.map(user => <b>user</b>)
			}
			
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should replace props nested props properly', function () {
		const INPUT = `
			export async function getStaticProps() {
				const allPosts = await promise;
				return { props: { allPosts } };
			}

			export default function Component({ allPosts: { edges }}) {
			return edges.map(edge => <b>edge</b>)
	          }
	      `;

		const OUTPUT = `
			import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
			import { headers, cookies } from "next/headers";	
			import { GetStaticPropsContext } from "next";
		
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
					params: Params
searchParams: Params
			};
			
			export async function getStaticProps() {
				const allPosts = await promise;
				return { props: { allPosts } };
			}

			async function getData(props: GetStaticPropsContext) {
				const allPosts = await promise;
				return  { allPosts };
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { allPosts: { edges } } = await getData(legacyCtx);

				return edges.map(edge => <b>edge</b>)
			}
			
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should create additional functions if getStaticProps is present', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			export default function Component({ users, groups }) {
				return [...users, ...groups].map(obj => <b>{obj}</b>)
	          }
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;

				return { users, groups };
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {users, groups } = await getData(legacyCtx);

				return [...users, ...groups].map(obj => <b>{obj}</b>)
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when props are not destructured', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}

			function SingleAppPage(props: inferSSRProps<typeof getStaticProps>) {
					return null;
			}
			
			export default SingleAppPage;
			
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				return { users };
			}

			async function SingleAppPage({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const props = await getData(legacyCtx);
				return null;
			}

			export default SingleAppPage;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when export keyword is used', function () {
		const INPUT = `
			export async function getStaticProps() {
				return { props: { a } };
			}

			export function SingleAppPage(props: inferSSRProps<typeof getStaticProps>) {
					return null;
			}
			
			export default SingleAppPage;
			
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
				params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				return { props: { a } };
			}

			async function getData(props: GetStaticPropsContext) {
				return { a } ;
			}
			
			export async function SingleAppPage({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const props = await getData(legacyCtx);
				return null;
			}

			export default SingleAppPage;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when export keyword is used 2', function () {
		const INPUT = `
			export async function getStaticProps() {
				return { props: { a } };
			}

			export const SingleAppPage = (props: inferSSRProps<typeof getStaticProps>) => {
					return null;
			}
			
			export default SingleAppPage;
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				return { props: { a } };
			}

			async function getData(props: GetStaticPropsContext) {
				return { a } ;
			}
			
			export const SingleAppPage = async ({ params: pageParams, searchParams: pageSearchParams }: PageProps) => {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const props = await getData(legacyCtx);
				return null;
			}

			export default SingleAppPage;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when Page has 0 args', function () {
		const INPUT = `
			export async function getStaticProps() {
				sideEffect();
				return { props: { a } };
			}

			export const SingleAppPage = () => {
					return null;
			}
			
			export default SingleAppPage;
			
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				sideEffect();
				return { props: { a } };
			}
			
			async function getData(props: GetStaticPropsContext) {
				sideEffect();
				return { a } ;
			}

			export const SingleAppPage = async ({ params: pageParams, searchParams: pageSearchParams }: PageProps) => {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				await getData(legacyCtx);
				return null;
			}
			
			export default SingleAppPage;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when Page component has implicit return', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}

			const Home = ({ users }) => (<Component users={users} />);
			
			export default Home;
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};
		
			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				return { users } ;
			}

			const Home = async ({ params: pageParams, searchParams: pageSearchParams }: PageProps) => {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users } = await getData(legacyCtx);
				return (<Component users={users} />)
			};
			
			export default Home;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when Page component has implicit return 2', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}

			const Home = ({ users }) => (<><Component users={users} /></>);
			
			export default Home;
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				return { users } ;
			}
			
			const Home = async ({ params: pageParams, searchParams: pageSearchParams }: PageProps) => {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users } = await getData(legacyCtx);
				return (<><Component users={users} /></>)
			};
			
			export default Home;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should inject data fetching function when Page component is functionexpression', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}

			const AppPage: AppPageType['default'] = function AppPage(props) {
				return null;
			};
			
			export default AppPage;
	    `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				const users = await promise;
				return { props: { users } };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				return { users } ;
			}

			const AppPage: AppPageType['default'] = async function AppPage({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const props = await getData(legacyCtx);
				return null;
			};
			
			export default AppPage;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should add data hooks on the top level of the component ', function () {
		const INPUT = `
			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			export default async function Component({ users, groups }) {
				return <C prop={(a) => {
					return a;
				}}
	      />
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
				params: Params
searchParams: Params
			};

			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;
				return { users, groups } ;
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users, groups } = await getData(legacyCtx);

				return <C prop={(a) => {
					return a;
				}} />
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should add generated code after import statements', function () {
		const INPUT = `
			import x from "y";
			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			export default function Component({ users, groups }) {
				return <C prop={(a) => {
					return a;
				}}
	      />
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import x from "y";
			
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
				params: Params
searchParams: Params
			};
		
			export async function getStaticProps() {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;
				return { users, groups } ;
			}
			
			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users, groups } = await getData(legacyCtx);

				return <C prop={(a) => {
					return a;
				}} />
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should work with arrow functions', function () {
		const INPUT = `
			import x from "y";
			export const getStaticProps = async () => {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			export default function Component({ users, groups }) {
				return <C prop={(a) => {
					return a;
				}}
	      />
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import x from "y";
			
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export const getStaticProps = async () => {
				const users = await promise;
				const groups = await anotherPromise;

				return { props: { users, groups }, revalidate: 1 };
			}

			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;
				return { users, groups } ;
			}
			
			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users, groups } = await getData(legacyCtx);

				return <C prop={(a) => {
					return a;
				}} />
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should work with hooks that have multiple return statements', function () {
		const INPUT = `
			import x from "y";
			export const getStaticProps =  async () => {
				const users = await promise;
				const groups = await anotherPromise;

				if(false) {
					return { props: { users, groups }}
				}

				return { props: { users, groups }, revalidate: 1 };
			}

			export default function Component({ users, groups }) {
				return <C prop={(a) => {
					return a;
				}}
	      />
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import x from "y";
			
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
				params: Params
searchParams: Params
			};

			export const getStaticProps =  async () => {
				const users = await promise;
				const groups = await anotherPromise;

				if(false) {
					return { props: { users, groups }}
				}

				return { props: { users, groups }, revalidate: 1 };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;
				
				if(false) {
					return  { users, groups }
				}
				
				return { users, groups } ;
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users, groups } = await getData(legacyCtx);

				return <C prop={(a) => {
					return a;
				}} />
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should not duplicate revalidate prop', function () {
		const INPUT = `
			import x from "y";
			
			export const getStaticProps = async () => {
				const users = await promise;
				const groups = await anotherPromise;

				if(false) {
					return { props: { users, groups }, revalidate: 1 }
				}

				return { props: { users, groups }, revalidate: 1 };
			}

			export default async function Component({ users, groups }) {
				return <C prop={(a) => {
					return a;
				}}
	      />
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import x from "y";
			
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};
		
			export const getStaticProps = async () => {
				const users = await promise;
				const groups = await anotherPromise;

				if(false) {
					return { props: { users, groups }, revalidate: 1}
				}

				return { props: { users, groups }, revalidate: 1 };
			}
			
			async function getData(props: GetStaticPropsContext) {
				const users = await promise;
				const groups = await anotherPromise;
				
				if(false) {
					return  { users, groups }
				}
				
				return { users, groups } ;
			}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const { users, groups } = await getData(legacyCtx);

				return <C prop={(a) => {
					return a;
				}} />
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should add dynamic="force-static" if a page implements getStaticProps', function () {
		const INPUT = `
			
		export const getStaticProps = async () => {
			return { props: {}, revalidate: 1 }
		}

			export default async function Component() {
				return null;
			}
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};
		
			export const getStaticProps = async () => {
				return { props: {}, revalidate: 1 }
			}
			
			async function getData(props: GetStaticPropsContext) {
				return {};
			}	
			
			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				await getData(legacyCtx);

				return null;
			}

			export const revalidate = 1;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT?.replace(/\W/gm, ''),
		);
	});

	it('should replace getServerSideProps', function () {
		const INPUT = `
			export async function getServerSideProps() {
				const res = await fetch(\`https://...\`);
				const projects = await res.json();

				return { props: { projects } };
			}

			export default function Dashboard({ projects }) {
				return (
					<ul>
						{projects.map((project) => (
							<li key={project.id}>{project.name}</li>
						))}
					</ul>
				);
			}
		`;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetServerSidePropsContext } from "next";
			type Params = {
				[key: string]: string | string[] | undefined
			};
	
			type PageProps = {
				params: Params
searchParams: Params
			};
		
			export async function getServerSideProps() {
				const res = await fetch(\`https://...\`);
				const projects = await res.json();

				return { props: { projects } };
			}

			async function getData(props: GetServerSidePropsContext) {
				const res = await fetch(\`https://...\`);
				const projects = await res.json();
				
				return { projects } ;
			}

			export default async function Dashboard({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {projects} = await getData(legacyCtx);
				return (
					<ul>
						{projects.map((project) => (
							<li key={project.id}>{project.name}</li>
						))}
					</ul>
				);
			}
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should handle getStaticPaths', function () {
		const INPUT = `
			import PostLayout from '@/components/post-layout';

			export async function getStaticPaths() {
				return {
					paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
					fallback: true,
				};
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			export default function Post({ post }) {
				return <PostLayout post={post} />;
			}
		`;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import PostLayout from '@/components/post-layout';
		
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};
		
			export async function getStaticPaths() {
				return {
						paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
									fallback: true,
				};
			}

			export async function generateStaticParams() {
				return (await getStaticPaths({})).paths;
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			async function getData({ params }: GetStaticPropsContext) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();
				
				return { post } ;
			}

			export default async function Post({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {post} = await getData(legacyCtx);

				return <PostLayout post={post} />;
			}

			export const dynamicParams = true;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should transform fallback property correctly 2', function () {
		const INPUT = `
			import PostLayout from '@/components/post-layout';

			export async function getStaticPaths() {
				return {
					paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
					fallback: false,
				};
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			export default function Post({ post }) {
				return <PostLayout post={post} />;
			}
		`;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import PostLayout from '@/components/post-layout';
		
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};
			
			export async function getStaticPaths() {
				return {
						paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
									fallback: false,
				};
			}

			export async function generateStaticParams() {
				return (await getStaticPaths({})).paths;
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			async function getData({ params }: GetStaticPropsContext) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();
				
				return { post } ;
			}

			export default async function Post({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {post} = await getData(legacyCtx);

				return <PostLayout post={post} />;
			}

			export const dynamicParams = false;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should transform fallback property correctly', function () {
		const INPUT = `
			import PostLayout from '@/components/post-layout';

			export async function getStaticPaths() {
				return {
					paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
					fallback: 'blocking',
				};
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			export default function Post({ post }) {
				return <PostLayout post={post} />;
			}
		`;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import PostLayout from '@/components/post-layout';
		
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticPaths() {
				return {
						paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
									fallback: 'blocking',
				};
			}

			export async function generateStaticParams() {
				return (await getStaticPaths({})).paths;
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			async function getData({ params }: GetStaticPropsContext) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();
				
				return { post } ;
			}

			export default async function Post({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {post} = await getData(legacyCtx);

				return <PostLayout post={post} />;
			}

			export const dynamicParams = true;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should move the default export to the bottom of the file', function () {
		const INPUT = `
			import PostLayout from '@/components/post-layout';

			export default function Post({ post }) {
				return <PostLayout post={post} />;
			}

			export async function getStaticPaths() {
				return {
					paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
					fallback: 'blocking',
				};
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}
		`;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
			import PostLayout from '@/components/post-layout';
		
			type Params = {
				[key: string]: string | string[] | undefined
			};

			type PageProps = {
					params: Params
searchParams: Params
			};

			export async function getStaticPaths() {
				return {
						paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
									fallback: 'blocking',
				};
			}

			export async function generateStaticParams() {
				return (await getStaticPaths({})).paths;
			}

			export async function getStaticProps({ params }) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();

				return { props: { post } };
			}

			async function getData({ params }: GetStaticPropsContext) {
				const res = await fetch(\`https://.../posts/\${params.id}\`);
				const post = await res.json();
				
				return { post } ;
			}

			export default async function Post({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {post} = await getData(legacyCtx);

				return <PostLayout post={post} />;
			}

			export const dynamicParams = true;
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);

		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});

	it('should wrap original getStaticProps when at least one of returnStatement argument is not ObjectExpression', function () {
		const INPUT = `
			export async function getStaticProps() {
				return fetchData();
			}

			export default function Component({ users }) {
				return users.map(user => <b>user</b>)
	          }
	      `;

		const OUTPUT = `
		import { buildLegacyCtx } from "/opt/project/hooks/buildLegacyCtx.tsx";
		import { headers, cookies } from "next/headers";	
		import { GetStaticPropsContext } from "next";
		import { notFound, redirect } from "next/navigation";
		type Params = {
			[key: string]: string | string[] | undefined
		};

		type PageProps = {
				params: Params
searchParams: Params
		};
		
			export async function getStaticProps() {
				return fetchData();
			}

			const getData = async (ctx: GetStaticPropsContext) => {
				const result = await getStaticProps(ctx);
				
				if("redirect" in result) {
						redirect(result.redirect.destination);
				}
				
				if("notFound" in result) {
						notFound();
				}
				
				return "props" in result ? result.props : {};
		}

			export default async function Component({ params: pageParams, searchParams: pageSearchParams }: PageProps) {
				const legacyCtx = buildLegacyCtx(pageParams, pageSearchParams, headers(), cookies());
				const {users} = await getData(legacyCtx);

				return users.map(user => <b>user</b>)
			}
			
			export const dynamic = "force-static";
		`;

		const actualOutput = jscodeshiftTransform(
			jscodeshift.withParser('tsx'),
			INPUT,
			globalOptions,
		);
		assert.deepEqual(
			actualOutput?.replace(/\W/gm, ''),
			OUTPUT.replace(/\W/gm, ''),
		);
	});
});
