import {
	API,
	ArrowFunctionExpression,
	Collection,
	File,
	FileInfo,
	FunctionDeclaration,
	FunctionExpression,
	Identifier,
	JSCodeshift,
	ObjectPattern,
	ObjectProperty,
	Options,
	Transform,
} from 'jscodeshift';

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

	return lastImportDeclarationIndex === -1
		? 0
		: lastImportDeclarationIndex + 1;
};

/**
 * factories
 */

const generateStaticParamsMethodFactory = (j: JSCodeshift) => {
	const functionDeclaration = j(`async function generateStaticParams() {
		return (await getStaticPaths({})).paths;
	}`)
		.find(j.FunctionDeclaration)
		.paths()[0]!;

	return j.exportNamedDeclaration(functionDeclaration.value);
};

const getDataMethodFactory = (
	j: JSCodeshift,
	argName: string,
	argType: string,
	decoratedMethodName: string,
) => {
	return j(`
	async function getData(${argName}: ${argType}) {
		return (await ${decoratedMethodName}(ctx)).props;
	}`)
		.find(j.FunctionDeclaration)
		.paths()[0]!;
};

const serverHookParamsFactory = (j: JSCodeshift) => {
	return j.identifier.from({
		name: 'params',
		typeAnnotation: j.tsTypeAnnotation(
			j.tsTypeReference(j.identifier('PageParams')),
		),
	});
};

const addGenerateStaticParamsFunctionDeclaration: ModFunction<File, 'write'> = (
	j,
	root,
) => {
	const generateStaticParamsMethod = generateStaticParamsMethodFactory(j);

	root.find(j.Program).forEach((program) => {
		const insertPosition = getFirstIndexAfterImports(j, root);

		program.value.body.splice(
			insertPosition,
			0,
			generateStaticParamsMethod,
		);
	});

	return [true, []];
};

const addPageParamsTypeAlias: ModFunction<File, 'write'> = (j, root) => {
	const pageParamsType = j.tsTypeAliasDeclaration(
		j.identifier('PageParams'),
		j.tsTypeLiteral([]),
	);

	const pagePropsType = j.tsTypeAliasDeclaration(
		j.identifier('PageProps'),
		j.tsTypeLiteral([
			j.tsPropertySignature(
				j.identifier('params'),
				j.tsTypeAnnotation(
					j.tsTypeReference(j.identifier('PageParams')),
				),
			),
		]),
	);

	root.find(j.Program).forEach((program) => {
		const insertPosition = getFirstIndexAfterImports(j, root);

		program.value.body.splice(
			insertPosition,
			0,
			...[pageParamsType, pagePropsType],
		);
	});

	return [true, []];
};

const addImportStatement: ModFunction<File, 'write'> = (j, root, settings) => {
	if (typeof settings.statement !== 'string') {
		return [false, []];
	}

	const alreadyExists =
		root.find(j.ImportDeclaration, {
			specifiers: [
				{
					type: 'ImportSpecifier',
					imported: {
						type: 'Identifier',
						name: settings.statement,
					},
				},
			],
			source: {
				type: 'StringLiteral',
				value: 'next',
			},
		}).length !== 0;

	if (alreadyExists) {
		return [false, []];
	}

	const importSpecifier = j.importSpecifier(j.identifier(settings.statement));

	const importDeclaration = j.importDeclaration(
		[importSpecifier],
		j.literal('next'),
	);

	root.find(j.Program).get('body', 0).insertBefore(importDeclaration);

	return [false, []];
};

const addGetDataFunction: ModFunction<File, 'write'> = (j, root, settings) => {
	const { functionName, argName, argType } = settings;

	const getDataFunctionDeclaration = getDataMethodFactory(
		j,
		argName as string,
		argType as string,
		functionName as string,
	);

	const program = root.find(j.Program);

	const programNode = program.paths()[0] ?? null;

	if (programNode === null) {
		return [false, []];
	}

	programNode.value.body.splice(
		getFirstIndexAfterImports(j, root),
		0,
		getDataFunctionDeclaration.value,
	);

	return [true, [[addImportStatement, root, { statement: argType }]]];
};

const DATA_FETCHING_METHOD_NAMES = ['getServerSideProps', 'getStaticProps'];

// @TODO fix code duplication
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

		if (DATA_FETCHING_METHOD_NAMES.includes(id.name)) {
			lazyModFunctions.push(
				[
					addGetDataFunction,
					root,
					{
						...settings,
						functionName: id.name,
						argName: 'ctx',
						argType:
							id.name === 'getStaticProps'
								? 'GetStaticPropsContext'
								: 'GetServerSidePropsContext',
					},
				],
				[findReturnStatements, functionDeclarationCollection, settings],
				[
					findComponentFunctionDefinition,
					root,
					{ name: '', includeParams: settings.includeParams },
				],
			);
		}

		if (id.name === 'getStaticPaths') {
			const newSettings = { ...settings, methodName: 'getStaticPaths' };

			lazyModFunctions.push(
				[
					findReturnStatements,
					functionDeclarationCollection,
					newSettings,
				],
				[addGenerateStaticParamsFunctionDeclaration, root, newSettings],
				[addPageParamsTypeAlias, root, newSettings],
			);
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

	const variableDeclaratorCollection = root
		.find(j.VariableDeclarator)
		.filter((variableDeclaratorPath) => {
			const id = variableDeclaratorPath.value.id;

			return (
				j.Identifier.check(id) &&
				DATA_FETCHING_METHOD_NAMES.includes(id.name)
			);
		});

	variableDeclaratorCollection
		.find(j.ArrowFunctionExpression)
		.forEach((arrowFunctionExpressionPath) => {
			const id = arrowFunctionExpressionPath.parent.value
				.id as Identifier;

			if (!j.Identifier.check(id)) {
				return;
			}

			if (DATA_FETCHING_METHOD_NAMES.includes(id.name)) {
				lazyModFunctions.push(
					[
						addGetDataFunction,
						root,
						{
							...settings,
							functionName: id.name,
							argName: 'ctx',
							argType:
								id.name === 'getStaticProps'
									? 'GetStaticPropsContext'
									: 'GetServerSidePropsContext',
						},
					],
					[
						findReturnStatements,
						j(arrowFunctionExpressionPath),
						settings,
					],
					[
						findComponentFunctionDefinition,
						root,
						{ name: '', includeParams: settings.includeParams },
					],
				);
			}

			if (id.name === 'getStaticPaths') {
				const newSettings = {
					...settings,
					methodName: 'getStaticPaths',
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
					[addPageParamsTypeAlias, root, newSettings],
				);
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

	root.find(j.ReturnStatement).forEach((returnStatementPath) => {
		const returnStatementCollection = j(returnStatementPath);

		if (settings.methodName === 'getStaticPaths') {
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

	return [false, lazyModFunctions];
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
	
	lazyModFunctions.push([addGetDataVariableDeclaration, j(pageComponentFunction), settings]);

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
	});

	root.forEach((path) => {
		const { body, params } = path.value;

		const firstParam = params[0] ?? null;

		const callExpression = j.awaitExpression(
			j.callExpression(j.identifier(`getData`), [getDataArgObjectExpression]),
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

	return [false, []];
};

export default function transform(
	file: FileInfo,
	api: API,
	_: Options,
): string | undefined {
	const j = api.jscodeshift;

	let dirtyFlag = false;

	const root = j(file.source);

	const hasGetStaticPathsMethod =
		root.find(j.FunctionDeclaration, {
			id: {
				type: 'Identifier',
				name: 'getStaticPaths',
			},
		}).length !== 0;

	const settings = {
		includeParams: hasGetStaticPathsMethod,
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

	return root.toSource();
}

transform satisfies Transform;
