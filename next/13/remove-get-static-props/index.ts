import {
	API,
	ASTNode,
	ArrowFunctionExpression,
	Collection,
	File,
	FileInfo,
	FunctionDeclaration,
	FunctionExpression,
	Identifier,
	JSCodeshift,
	Transform,
} from 'jscodeshift';
import type { HandleData, HandleFile, Filemod } from '@intuita-inc/filemod';

type Dependencies = Readonly<{
	jscodeshift: JSCodeshift;
}>;

type State = {
	step: RepomodStep
}

type FileCommand = Awaited<ReturnType<HandleFile<Dependencies, State>>>[number];

const noop = {
	kind: 'noop',
} as const;

const ADD_BUILD_LEGACY_CTX_UTIL_CONTENT = `
import { ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";
import { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { headers, cookies } from "next/headers";

// returns query object same as ctx.query but for app dir
export const getQuery = (url: string, params: Record<string, string | string[]>) => {
  if (!url.length) {
    return params;
  }

  const { searchParams } = new URL(url);
  const searchParamsObj = Object.fromEntries(searchParams.entries());

  return { ...searchParamsObj, ...params };
};

export const buildLegacyContext = (headers: ReadonlyHeaders, cookies: ReadonlyRequestCookies, params: Record<string, string | string[]>) => {
  return {
    query: getQuery(headers.get('x-url') ?? '', params), 
    params, 
    req: { headers, cookies }
  }
}
`

type Settings = Partial<Record<string, string | boolean | Collection<any>>>;

type ModFunction<T, D extends 'read' | 'write'> = (
	j: JSCodeshift,
	root: Collection<T>,
	settings: Settings,
) => [D extends 'write' ? boolean : false, ReadonlyArray<LazyModFunction>];

type LazyModFunction = [
	ModFunction<any, 'read' | 'write'>,
	Collection<any>,
	Settings,
];

const findLastIndex = <T>(
	array: Array<T>,
	predicate: (value: T, index: number, obj: T[]) => boolean,
): number => {
	let l = array.length;
	while (l--) {
		if (predicate(array[l]!, l, array)) return l;
	}
	return -1;
};

const getFirstIndexAfterImports = (j: JSCodeshift, file: Collection<File>) => {
	const programBody = file.find(j.Program).paths()[0]?.value.body ?? [];

	const lastImportDeclarationIndex = findLastIndex(programBody, (node) =>
		j.ImportDeclaration.check(node),
	);

	return lastImportDeclarationIndex + 1;
};

const getFirstIndexAfterExportNamedFunctionDeclaration = (
	j: JSCodeshift,
	body: unknown[],
	functionName: string,
): number => {
	const lastImportDeclarationIndex = findLastIndex(body, (node) => {
		// function declaration within an export named declaration
		if (
			j.ExportNamedDeclaration.check(node) &&
			j.FunctionDeclaration.check(node.declaration) &&
			j.Identifier.check(node.declaration.id) &&
			node.declaration.id.name === functionName
		) {
			return true;
		}

		// variable declarator within an export named declaration
		if (
			j.ExportNamedDeclaration.check(node) &&
			j.VariableDeclaration.check(node.declaration)
		) {
			const [declaration] = node.declaration.declarations;

			return (
				j.VariableDeclarator.check(declaration) &&
				j.Identifier.check(declaration.id) &&
				declaration.id.name === functionName
			);
		}

		if (
			j.FunctionDeclaration.check(node) &&
			j.Identifier.check(node.id) &&
			node.id.name === functionName
		) {
			return true;
		}

		return false;
	});

	return lastImportDeclarationIndex + 1;
};

/**
 * factories
 */

const generateStaticParamsFunctionFactory = (j: JSCodeshift) => {
	const functionDeclaration = j(`async function generateStaticParams() {
		return (await getStaticPaths({})).paths;
	}`)
		.find(j.FunctionDeclaration)
		.paths()[0]!;

	return j.exportNamedDeclaration(functionDeclaration.value);
};

const getDataFunctionFactory = (
	j: JSCodeshift,
	decoratedFunctionName: string,
) => {
	return j(`
	async function getData({ params }: { params: Params }) {
		const ctx  = buildLegacyContext({ params, ${
			decoratedFunctionName === 'getStaticProps'
				? ''
				: 'headers: headers(), cookies: cookies()'
		}});
		const result = await ${decoratedFunctionName}(ctx);
		
		if("redirect" in result) {
			redirect(result.redirect.destination);	
		}
		
		if("notFound" in result) {
			notFound();
		}
		
		return "props" in result ? result.props : {};
	}`)
		.find(j.FunctionDeclaration)
		.paths()[0]!;
};

const addGenerateStaticParamsFunctionDeclaration: ModFunction<File, 'write'> = (
	j,
	root,
) => {
	const generateStaticParamsFunction = generateStaticParamsFunctionFactory(j);

	root.find(j.Program).forEach((program) => {
		program.value.body.splice(
			getFirstIndexAfterExportNamedFunctionDeclaration(
				j,
				root.find(j.Program).paths()[0]?.value.body ?? [],
				'getStaticPaths',
			),
			0,
			generateStaticParamsFunction,
		);
	});

	return [true, []];
};

const addPageParamsTypeAlias: ModFunction<File, 'write'> = (j, root) => {
	const pageParamsType = j.tsTypeAliasDeclaration(
		j.identifier('Params'),
		j.tsTypeLiteral([
			j.tsIndexSignature(
				[j.identifier('key: string')],
				j.tsTypeAnnotation(
					j.tsUnionType([
						j.tsStringKeyword(),
						j.tsArrayType(j.tsStringKeyword()),
						j.tsUndefinedKeyword(),
					]),
				),
			),
		]),
	);

	const pagePropsType = j.tsTypeAliasDeclaration(
		j.identifier('PageProps'),
		j.tsTypeLiteral([
			j.tsPropertySignature(
				j.identifier('params'),
				j.tsTypeAnnotation(j.tsTypeReference(j.identifier('Params'))),
			),
		]),
	);

	root.find(j.Program).forEach((program) => {
		program.value.body.splice(
			getFirstIndexAfterImports(j, root),
			0,
			...[pageParamsType, pagePropsType],
		);
	});

	return [true, []];
};

const addImportStatement: ModFunction<File, 'write'> = (j, root, settings) => {
	if (
		typeof settings.specifierNames !== 'string' ||
		typeof settings.sourceName !== 'string'
	) {
		return [false, []];
	}

	const specifiers = settings.specifierNames.split(',');

	const alreadyExists =
		root.find(j.ImportDeclaration, {
			specifiers: specifiers.map((s) => ({
				type: 'ImportSpecifier' as const,
				imported: {
					type: 'Identifier' as const,
					name: s,
				},
			})),
			source: {
				type: 'StringLiteral',
				value: settings.sourceName,
			},
		}).length !== 0;

	if (alreadyExists) {
		return [false, []];
	}

	const importDeclaration = j.importDeclaration(
		specifiers.map((s) => j.importSpecifier(j.identifier(s))),
		j.literal(settings.sourceName),
	);

	root.find(j.Program).get('body', 0).insertBefore(importDeclaration);

	return [false, []];
};

const addGetDataFunctionAsWrapper: ModFunction<File, 'write'> = (
	j,
	root,
	settings,
) => {
	const functionName = settings.functionName as string;

	const getDataFunctionDeclaration = getDataFunctionFactory(j, functionName);

	const program = root.find(j.Program);

	const programNode = program.paths()[0] ?? null;

	if (programNode === null) {
		return [false, []];
	}

	programNode.value.body.splice(
		getFirstIndexAfterExportNamedFunctionDeclaration(
			j,
			root.find(j.Program).paths()[0]?.value.body ?? [],
			functionName,
		),
		0,
		getDataFunctionDeclaration.value,
	);

	return [
		true,
		[
			[
				addImportStatement,
				root,
				{
					specifierNames: 'notFound,redirect',
					sourceName: 'next/navigation',
				},
			],
			[
				addImportStatement,
				root,
				{
					specifierNames: 'buildLegacyCtx',
					sourceName: '@lib/buildLegacyCtx',
				},
			],
			[addPageParamsTypeAlias, root, {}],
		],
	];
};

const deepCloneCollection = <T extends ASTNode>(
	j: JSCodeshift,
	root: Collection<T>,
) => {
	return j(root.toSource());
};

const addGetDataFunctionInline: ModFunction<File, 'write'> = (
	j,
	root,
	settings,
) => {
	const clonedFunctionCollection = deepCloneCollection(
		j,
		settings.function as Collection<FunctionDeclaration>,
	);

	const clonedFunctionDeclarationCollection = clonedFunctionCollection.find(
		j.FunctionDeclaration,
	);
	const clonedFArrowFunctionExpressionCollection =
		clonedFunctionCollection.find(j.ArrowFunctionExpression);

	const clonedFunction =
		clonedFunctionDeclarationCollection.paths()[0] ??
		clonedFArrowFunctionExpressionCollection.paths()[0] ??
		null;

	if (clonedFunction === null) {
		return [false, []];
	}

	let usedRedirect = false;
	let usedNotFound = false;

	clonedFunctionCollection
		.find(j.ReturnStatement)
		.forEach((returnStatementPath) => {
			const { argument } = returnStatementPath.value;

			if (j.ObjectExpression.check(argument)) {
				j(argument)
					.find(j.ObjectProperty)
					.forEach((property) => {
						if (
							!j.ObjectExpression.check(property.value.value) ||
							!j.Identifier.check(property.value.key)
						) {
							return;
						}

						const { key, value } = property.value;

						if (key.name === 'props') {
							returnStatementPath.value.argument = value;
						}

						if (key.name === 'redirect') {
							j(value)
								.find(j.ObjectProperty, {
									key: {
										type: 'Identifier',
										name: 'destination',
									},
								})
								.forEach((objectPropertyPath) => {
									if (
										!j.StringLiteral.check(
											objectPropertyPath.value.value,
										) &&
										!j.Identifier.check(
											objectPropertyPath.value.value,
										)
									) {
										return;
									}

									returnStatementPath.value.argument =
										j.callExpression(
											j.identifier('redirect'),
											[objectPropertyPath.value.value],
										);
								});

							usedRedirect = true;
						}

						if (key.name === 'notFound') {
							returnStatementPath.value.argument =
								j.callExpression(j.identifier('notFound'), []);

							usedNotFound = true;
						}
					});
			}
		});

	const contextTypeName =
		settings.functionName === 'getStaticProps'
			? 'GetStaticPropsContext'
			: 'GetServerSidePropsContext';

	const params = clonedFunction.value.params.length
		? clonedFunction.value.params
		: [j.identifier('props')];

	params.forEach((p) => {
		if (
			(j.ObjectPattern.check(p) || j.Identifier.check(p)) &&
			!p.typeAnnotation
		) {
			p.typeAnnotation = j.tsTypeAnnotation(
				j.tsTypeReference(j.identifier(contextTypeName)),
			);
		}
	});

	const getDataFunctionDeclaration = j.functionDeclaration.from({
		params,
		body:
			clonedFunction.value.body.type === 'BlockStatement'
				? clonedFunction.value.body
				: j.blockStatement([]),
		id: j.identifier('getData'),
		async: true,
	});

	const program = root.find(j.Program);

	const programNode = program.paths()[0] ?? null;

	if (programNode === null) {
		return [false, []];
	}

	programNode.value.body.splice(
		getFirstIndexAfterExportNamedFunctionDeclaration(
			j,
			root.find(j.Program).paths()[0]?.value.body ?? [],
			settings.functionName as string,
		),
		0,
		getDataFunctionDeclaration,
	);

	const lazyModFunctions: LazyModFunction[] = [];

	const specifierNames: string[] = [];

	if (usedNotFound) {
		specifierNames.push('notFound');
	}

	if (usedRedirect) {
		specifierNames.push('redirect');
	}

	if (specifierNames.length !== 0) {
		lazyModFunctions.push([
			addImportStatement,
			root,
			{
				specifierNames: specifierNames.join(),
				sourceName: 'next/navigation',
			},
		]);
	}

	if (params.length !== 0) {
		lazyModFunctions.push([
			addImportStatement,
			root,
			{
				specifierNames: contextTypeName,
				sourceName: 'next',
			},
		]);
	}

	lazyModFunctions.push([addPageParamsTypeAlias, root, {}]);

	return [true, lazyModFunctions];
};

const DATA_FETCHING_FUNCTION_NAMES = ['getServerSideProps', 'getStaticProps'];

export const findFunctionDeclarations: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const functionDeclarations = root.find(j.FunctionDeclaration);

	functionDeclarations.forEach((functionDeclarationPath) => {
		const functionDeclarationCollection = j(functionDeclarationPath);

		const { id } = functionDeclarationPath.value;

		if (!j.Identifier.check(id)) {
			return;
		}

		if (DATA_FETCHING_FUNCTION_NAMES.includes(id.name)) {
			lazyModFunctions.push(
				[
					findReturnStatements,
					functionDeclarationCollection,
					{
						...settings,
						functionName: id.name,
					},
				],
				[findComponentFunctionDefinition, root, settings],
			);
		}

		if (id.name === 'getStaticPaths') {
			const newSettings = { ...settings, functionName: 'getStaticPaths' };

			lazyModFunctions.push(
				[
					findReturnStatements,
					functionDeclarationCollection,
					newSettings,
				],
				[addGenerateStaticParamsFunctionDeclaration, root, newSettings],
			);
		}

		if (id.name === 'getStaticProps') {
			lazyModFunctions.push([
				addDynamicVariableDeclaration,
				root,
				settings,
			]);
		}
	});

	return [false, lazyModFunctions];
};

export const findArrowFunctionExpressions: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const variableDeclaratorCollection = root.find(j.VariableDeclarator);

	variableDeclaratorCollection
		.find(j.ArrowFunctionExpression)
		.forEach((arrowFunctionExpressionPath) => {
			const id = arrowFunctionExpressionPath.parent.value
				.id as Identifier;

			if (!j.Identifier.check(id)) {
				return;
			}

			if (DATA_FETCHING_FUNCTION_NAMES.includes(id.name)) {
				lazyModFunctions.push(
					[
						findReturnStatements,
						j(arrowFunctionExpressionPath),
						{
							...settings,
							functionName: id.name,
						},
					],
					[findComponentFunctionDefinition, root, settings],
				);
			}

			if (id.name === 'getStaticPaths') {
				const newSettings = {
					...settings,
					functionName: 'getStaticPaths',
				};

				lazyModFunctions.push(
					[
						findReturnStatements,
						j(arrowFunctionExpressionPath),
						newSettings,
					],
					[
						addGenerateStaticParamsFunctionDeclaration,
						root,
						newSettings,
					],
				);
			}

			if (id.name === 'getStaticProps') {
				lazyModFunctions.push([
					addDynamicVariableDeclaration,
					root,
					settings,
				]);
			}
		});

	return [false, lazyModFunctions];
};

export const findReturnStatements: ModFunction<FunctionDeclaration, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const returnStatementCollection = root.find(j.ReturnStatement);

	returnStatementCollection.forEach((returnStatementPath) => {
		const returnStatementCollection = j(returnStatementPath);
		if (settings.functionName === 'getStaticPaths') {
			lazyModFunctions.push([
				findFallbackObjectProperty,
				returnStatementCollection,
				settings,
			]);

			return;
		}

		lazyModFunctions.push([
			findRevalidateObjectProperty,
			returnStatementCollection,
			settings,
		]);
	});

	if (settings.functionName === 'getStaticPaths') {
		return [false, lazyModFunctions];
	}

	const functionCanBeInlined = returnStatementCollection.every(
		(returnStatementPath) =>
			j.ObjectExpression.check(returnStatementPath.value.argument),
	);

	const file = root.closest(j.File);

	if (functionCanBeInlined) {
		lazyModFunctions.push([
			addGetDataFunctionInline,
			file,
			{ ...settings, function: root },
		]);
	} else {
		lazyModFunctions.push([addGetDataFunctionAsWrapper, file, settings]);
	}

	return [false, lazyModFunctions];
};

export const addDynamicVariableDeclaration: ModFunction<File, 'write'> = (
	j,
	root,
) => {
	const exportNamedDeclarationAlreadyExists =
		root.find(j.ExportNamedDeclaration, {
			declaration: {
				declarations: [
					{
						type: 'VariableDeclarator',
						id: {
							type: 'Identifier',
							name: 'dynamic',
						},
					},
				],
			},
		})?.length !== 0;

	let dirtyFlag = false;

	if (exportNamedDeclarationAlreadyExists) {
		return [dirtyFlag, []];
	}

	const exportNamedDeclaration = j.exportNamedDeclaration(
		j.variableDeclaration('const', [
			j.variableDeclarator(
				j.identifier('dynamic'),
				j.stringLiteral('force-static'),
			),
		]),
	);

	root.find(j.Program).forEach((program) => {
		dirtyFlag = true;

		program.value.body.push(exportNamedDeclaration);
	});

	return [dirtyFlag, []];
};

/**
 * {
 *  fallback: boolean | 'blocking';
 * }
 */
export const findFallbackObjectProperty: ModFunction<any, 'read'> = (
	j,
	root,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const fileCollection = root.closest(j.File);
	root.find(j.ObjectProperty, {
		key: {
			type: 'Identifier',
			name: 'fallback',
		},
	}).forEach((objectPropertyPath) => {
		const objectPropertyValue = objectPropertyPath.value.value;

		if (
			objectPropertyValue.type !== 'BooleanLiteral' &&
			!(
				objectPropertyValue.type === 'StringLiteral' &&
				objectPropertyValue.value === 'blocking'
			)
		) {
			return;
		}

		const fallback = objectPropertyValue.value;

		lazyModFunctions.push([
			addFallbackVariableDeclaration,
			fileCollection,
			{ fallback },
		]);
	});

	return [false, lazyModFunctions];
};

/**
 * export const dynamicParams = true;
 */
export const addFallbackVariableDeclaration: ModFunction<any, 'write'> = (
	j,
	root,
	settings,
) => {
	const exportNamedDeclarationAlreadyExists =
		root.find(j.ExportNamedDeclaration, {
			declaration: {
				declarations: [
					{
						type: 'VariableDeclarator',
						id: {
							type: 'Identifier',
							name: 'dynamicParams',
						},
					},
				],
			},
		})?.length !== 0;

	if (exportNamedDeclarationAlreadyExists) {
		return [false, []];
	}

	const dynamicParams =
		settings.fallback === true || settings.fallback === 'blocking';

	const exportNamedDeclaration = j.exportNamedDeclaration(
		j.variableDeclaration('const', [
			j.variableDeclarator(
				j.identifier('dynamicParams'),
				j.booleanLiteral(dynamicParams),
			),
		]),
	);

	let dirtyFlag = false;

	root.find(j.Program).forEach((program) => {
		dirtyFlag = true;

		program.value.body.push(exportNamedDeclaration);
	});

	return [dirtyFlag, []];
};

export const findRevalidateObjectProperty: ModFunction<any, 'read'> = (
	j,
	root,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const fileCollection = root.closest(j.File);

	root.find(j.ObjectProperty, {
		key: {
			type: 'Identifier',
			name: 'revalidate',
		},
		value: {
			type: 'NumericLiteral',
		},
	}).forEach((objectPropertyPath) => {
		const objectPropertyCollection = j(objectPropertyPath);

		objectPropertyCollection
			.find(j.NumericLiteral)
			.forEach((numericLiteralPath) => {
				const numericLiteral = numericLiteralPath.value;

				const revalidate = String(numericLiteral.value);

				lazyModFunctions.push([
					addRevalidateVariableDeclaration,
					fileCollection,
					{ revalidate },
				]);
			});
	});

	return [false, lazyModFunctions];
};

export const addRevalidateVariableDeclaration: ModFunction<any, 'write'> = (
	j,
	root,
	settings,
) => {
	const exportNamedDeclarationAlreadyExists =
		root.find(j.ExportNamedDeclaration, {
			declaration: {
				declarations: [
					{
						type: 'VariableDeclarator',
						id: {
							type: 'Identifier',
							name: 'revalidate',
						},
					},
				],
			},
		})?.length !== 0;

	if (exportNamedDeclarationAlreadyExists) {
		return [false, []];
	}

	const revalidate = parseInt(String(settings.revalidate) ?? '0', 10);

	const exportNamedDeclaration = j.exportNamedDeclaration(
		j.variableDeclaration('const', [
			j.variableDeclarator(
				j.identifier('revalidate'),
				j.numericLiteral(revalidate),
			),
		]),
	);

	let dirtyFlag = false;

	root.find(j.Program).forEach((program) => {
		dirtyFlag = true;

		program.value.body.push(exportNamedDeclaration);
	});

	return [dirtyFlag, []];
};

export const findComponentFunctionDefinition: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const program = root.find(j.Program).paths()[0] ?? null;

	if (program === null) {
		return [false, []];
	}

	const defaultExport =
		root.find(j.ExportDefaultDeclaration).paths()[0] ?? null;
	const defaultExportDeclaration = defaultExport?.value.declaration ?? null;

	let pageComponentFunction:
		| FunctionDeclaration
		| ArrowFunctionExpression
		| FunctionExpression
		| null = null;

	if (defaultExportDeclaration?.type === 'FunctionDeclaration') {
		pageComponentFunction = defaultExportDeclaration;
	}

	if (defaultExportDeclaration?.type === 'Identifier') {
		const program = root.find(j.Program).paths()[0] ?? null;

		(program?.value.body ?? []).forEach((node) => {
			let _node = node;

			// node can be within ExportNamedDeclaration
			if (
				j.ExportNamedDeclaration.check(node) &&
				(j.FunctionDeclaration.check(node.declaration) ||
					j.VariableDeclaration.check(node.declaration))
			) {
				_node = node.declaration;
			}

			if (
				j.FunctionDeclaration.check(_node) &&
				_node.id?.name === defaultExportDeclaration.name
			) {
				pageComponentFunction = _node;
			}

			if (
				j.VariableDeclaration.check(_node) &&
				j.VariableDeclarator.check(_node.declarations[0]) &&
				j.Identifier.check(_node.declarations[0].id) &&
				_node.declarations[0].id.name ===
					defaultExportDeclaration.name &&
				(j.ArrowFunctionExpression.check(_node.declarations[0].init) ||
					j.FunctionExpression.check(_node.declarations[0].init))
			) {
				pageComponentFunction = _node.declarations[0].init;
			}
		});
	}

	if (pageComponentFunction === null) {
		return [false, []];
	}

	lazyModFunctions.push([
		addGetDataVariableDeclaration,
		j(pageComponentFunction),
		settings,
	]);

	return [false, lazyModFunctions];
};

const addGetDataVariableDeclaration: ModFunction<
	FunctionDeclaration | ArrowFunctionExpression,
	'write'
> = (j, root) => {
	const getDataArgObjectExpression = j.objectExpression([
		j.objectProperty.from({
			key: j.identifier('params'),
			value: j.identifier('params'),
			shorthand: true,
		}),
	]);

	let addedVariableDeclaration = false;

	const componentPropsObjectPattern = j.objectPattern.from({
		properties: [
			j.objectProperty.from({
				key: j.identifier('params'),
				value: j.identifier('params'),
				shorthand: true,
			}),
		],
		typeAnnotation: j.tsTypeAnnotation(
			j.tsTypeReference(j.identifier('PageProps')),
		),
	});

	root.forEach((path) => {
		const { body, params } = path.value;

		const firstParam = params[0] ?? null;

		const callExpression = j.awaitExpression(
			j.callExpression(j.identifier(`getData`), [
				getDataArgObjectExpression,
			]),
		);

		const id = j.Identifier.check(firstParam)
			? j.identifier(firstParam.name)
			: j.ObjectPattern.check(firstParam)
			? j.objectPattern.from({
					...firstParam,
					typeAnnotation: null,
			  })
			: null;

		const variableDeclaration =
			id === null
				? j.expressionStatement(callExpression)
				: j.variableDeclaration('const', [
						j.variableDeclarator(id, callExpression),
				  ]);

		if (j.JSXElement.check(body) || j.JSXFragment.check(body)) {
			path.value.body = j.blockStatement.from({
				body: [variableDeclaration, j.returnStatement(body)],
			});

			addedVariableDeclaration = true;
			path.value.async = true;
			path.value.params = [componentPropsObjectPattern];
		}

		if (j.BlockStatement.check(body)) {
			body.body.unshift(variableDeclaration);
			addedVariableDeclaration = true;
			path.value.async = true;
			path.value.params = [componentPropsObjectPattern];
		}
	});

	return [addedVariableDeclaration, []];
};

const getExportDefaultName = (
	j: JSCodeshift,
	declaration: unknown,
): string | null => {
	if (!j.ExportDefaultDeclaration.check(declaration)) {
		return null;
	}

	if (!j.Identifier.check(declaration.declaration)) {
		return null;
	}

	return declaration.declaration.name;
};

function transform(
	j: JSCodeshift,
	source: string,
	options: Record<string, string>,
): string | undefined {

	let dirtyFlag = false;

	const root = j(source);

	const hasGetStaticPathsFunction =
		root.find(j.FunctionDeclaration, {
			id: {
				type: 'Identifier',
				name: 'getStaticPaths',
			},
		}).length !== 0;

	const settings = {
		includeParams: hasGetStaticPathsFunction,
	};

	const lazyModFunctions: LazyModFunction[] = [
		[findFunctionDeclarations, root, settings],
		[findArrowFunctionExpressions, root, settings],
	];

	const handleLazyModFunction = (lazyModFunction: LazyModFunction) => {
		const [modFunction, localCollection, localSettings] = lazyModFunction;

		const [localDirtyFlag, localLazyModFunctions] = modFunction(
			j,
			localCollection,
			localSettings,
		);

		dirtyFlag ||= localDirtyFlag;

		for (const localLazyModFunction of localLazyModFunctions) {
			handleLazyModFunction(localLazyModFunction);
		}
	};

	for (const lazyModFunction of lazyModFunctions) {
		handleLazyModFunction(lazyModFunction);
	}

	if (!dirtyFlag) {
		return undefined;
	}

	// move the default export behind getData
	root.find(j.Program).forEach((program) => {
		const body = program.value.body.slice();

		const index = body.findIndex((statement) =>
			j.ExportDefaultDeclaration.check(statement),
		);

		if (index === -1) {
			return;
		}

		const [exportDefaultDeclaration] = body.splice(index, 1);

		// e.g. export default Name;
		const exportDefaultName = getExportDefaultName(
			j,
			exportDefaultDeclaration,
		);

		if (!exportDefaultDeclaration) {
			return;
		}

		const namedFunctionIndex = body.findIndex((statement) => {
			if (j.FunctionDeclaration.check(statement)) {
				return (
					j.Identifier.check(statement.id) &&
					statement.id.name === exportDefaultName
				);
			}

			if (
				!j.ExportNamedDeclaration.check(statement) ||
				!j.VariableDeclaration.check(statement.declaration)
			) {
				return false;
			}

			const [declaration] = statement.declaration.declarations;

			if (
				!j.VariableDeclarator.check(declaration) ||
				!j.Identifier.check(declaration.id)
			) {
				return false;
			}

			return declaration.id.name === exportDefaultName;
		});

		if (namedFunctionIndex !== -1) {
			const [namedFunction] = body.splice(namedFunctionIndex, 1);

			const newIndex = getFirstIndexAfterExportNamedFunctionDeclaration(
				j,
				body,
				'getData',
			);

			if (newIndex === 0 || namedFunction === undefined) {
				return;
			}

			body.splice(newIndex, 0, namedFunction);
		}

		const newIndex = getFirstIndexAfterExportNamedFunctionDeclaration(
			j,
			body,
			exportDefaultName ?? 'getData',
		);

		if (newIndex === 0) {
			return;
		}

		body.splice(newIndex, 0, exportDefaultDeclaration);

		program.value.body = body;
	});

	return root.toSource();
}

const handleFile: HandleFile<
	Dependencies,
	State
>= async (_, path, options, state) => {
	const { buildLegacyCtxUtilAbsolutePath } = options;
	if(typeof buildLegacyCtxUtilAbsolutePath !== 'string') {
		throw new Error(`Expected buildLegacyCtxUtilAbsolutePath to be a string, got ${typeof buildLegacyCtxUtilAbsolutePath}`)
	}

	if(state === null) {
		return [];
	}

	const commands: FileCommand[] = [];

	if(state.step === RepomodStep.ADD_BUILD_LEGACY_CTX_UTIL) {
		commands.push({
			kind: 'upsertFile',
			path: buildLegacyCtxUtilAbsolutePath,
			options: {
				...options,
				fileContent: ADD_BUILD_LEGACY_CTX_UTIL_CONTENT,
			},
		});
	}


	commands.push({
		kind: 'upsertFile',
		path,
		options,
	});

	return commands;
};

const handleData: HandleData<Dependencies, State> = async (
	api,
	path,
	data,
	options,
	state,
) => {

	if(state === null) {
		return noop;
	}

	if(state.step === RepomodStep.ADD_BUILD_LEGACY_CTX_UTIL && typeof options.fileContent === 'string') {
		state.step = RepomodStep.ADD_GET_SERVER_SIDE_DATA_HOOKS;
		return {
			kind: 'upsertData',
			path,
			data: options.fileContent,
		};
	}

	if(state.step === RepomodStep.ADD_GET_SERVER_SIDE_DATA_HOOKS) {
		const { jscodeshift } = api.getDependencies();

		const rewrittenData = transform(jscodeshift, data, state);

		if (rewrittenData === undefined) {
			return noop;
		}

		return {
			kind: 'upsertData',
			path,
			data: rewrittenData,
		};
	}

	return noop;
};

const enum RepomodStep {
	ADD_BUILD_LEGACY_CTX_UTIL = "ADD_BUILD_LEGACY_CTX_UTIL", 
	ADD_GET_SERVER_SIDE_DATA_HOOKS = "ADD_GET_SERVER_SIDE_DATA_HOOKS"
} 

export const repomod: Filemod<Dependencies, State> = {
	includePatterns: ['**/pages/**/*.{js,jsx,ts,tsx}'],
	excludePatterns: ['**/node_modules/**', '**/pages/api/**'],
	initializeState: async (_, previousState)  => {

		if(previousState === null) {
			return {
				step: RepomodStep.ADD_BUILD_LEGACY_CTX_UTIL
			}
		}

		return previousState;
	},
	handleFile,
	handleData,
};
