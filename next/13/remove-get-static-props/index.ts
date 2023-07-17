import {
	API,
	ASTNode,
	ArrowFunctionExpression,
	Collection,
	File,
	FileInfo,
	FunctionDeclaration,
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

// @TODO
function findLastIndex<T>(
	array: Array<T>,
	predicate: (value: T, index: number, obj: T[]) => boolean,
): number {
	let l = array.length;
	while (l--) {
		if (predicate(array[l]!, l, array)) return l;
	}
	return -1;
}

/**
 * factories
 */

const generateStaticParamsMethodFactory = (j: JSCodeshift) => {
	const functionDeclaration = j(`async function generateStaticParams() {
		return (await _getStaticPaths({})).paths;
	}`)
		.find(j.FunctionDeclaration)
		.paths()[0]!;

	return j.exportNamedDeclaration(functionDeclaration.value);
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
		const lastImportDeclarationIndex = findLastIndex(
			program.value.body,
			(node) => node.type === 'ImportDeclaration',
		);

		const insertPosition =
			lastImportDeclarationIndex === -1
				? 0
				: lastImportDeclarationIndex + 1;

		program.value.body.splice(
			insertPosition,
			0,
			generateStaticParamsMethod,
		);
	});

	return [true, []];
};

const renameGetStaticPathsFunctionDeclaration: ModFunction<
	FunctionDeclaration,
	'write'
> = (j, root) => {
	root.forEach((functionDeclarationPath) => {
		const id = functionDeclarationPath.value.id;

		if (!id) {
			return;
		}

		id.name = '_getStaticPaths';
	});

	return [false, []];
};

const renameGetStaticPathsArrowFunction: ModFunction<any, 'write'> = (
	j,
	root,
) => {
	root.find(j.Identifier, {
		name: 'getStaticPaths',
	}).forEach((identifierPath) => {
		identifierPath.value.name = '_getStaticPaths';
	});

	return [false, []];
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
		const lastImportDeclarationIndex = findLastIndex(
			program.value.body,
			(node) => node.type === 'ImportDeclaration',
		);

		const insertPosition =
			lastImportDeclarationIndex === -1
				? 0
				: lastImportDeclarationIndex + 1;

		program.value.body.splice(
			insertPosition,
			0,
			...[pageParamsType, pagePropsType],
		);
	});

	return [true, []];
};

const deepCloneCollection = <T extends ASTNode>(
	j: JSCodeshift,
	root: Collection<T>,
) => {
	return j(root.toSource());
};

const addImportStatement: ModFunction<File, 'write'> = (j, root, settings) => {
	if (typeof settings.statement !== 'string') {
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

const addGetDataFunction: ModFunction<
	FunctionDeclaration | ArrowFunctionExpression,
	'write'
> = (j, root, settings) => {
	const cloned = deepCloneCollection(j, root);

	const clonedFunctionDeclarationCollection = cloned.find(
		j.FunctionDeclaration,
	);
	const clonedFArrowFunctionExpressionCollection = cloned.find(
		j.ArrowFunctionExpression,
	);

	const clonedFunction =
		clonedFunctionDeclarationCollection.paths()[0] ??
		clonedFArrowFunctionExpressionCollection.paths()[0] ??
		null;

	if (clonedFunction === null) {
		return [false, []];
	}

	j(clonedFunction)
		.find(j.ReturnStatement)
		.forEach((path) => {
			const node = path.value;

			const argument = node.argument;

			if (argument === null) {
				return;
			}

			// common case #1
			// return { props: ... }
			if (argument.type === 'ObjectExpression') {
				const props =
					j(argument)
						.find(j.ObjectProperty, {
							key: {
								type: 'Identifier',
								name: 'props',
							},
						})
						.paths()[0]?.value ?? null;

				if (props === null) {
					return;
				}

				const propsPropValue = props.value;

				// @TODO find a way to check if propsPropValue is ExpressionKind without making a lot of checks
				if (propsPropValue.type !== 'ObjectExpression') {
					return;
				}

				node.argument = propsPropValue;
			}

			// common case #2
			// res.props = ...;
			// return res;
			if (argument.type === 'Identifier') {
				node.argument = j.memberExpression(
					argument,
					j.identifier('props'),
				);
			}
		});

	const params = clonedFunction.value.params.length
		? clonedFunction.value.params
		: [j.identifier('ctx')];

	const contextTypeName =
		settings.methodName === 'getStaticProps'
			? 'GetStaticPropsContext'
			: 'GetServerSidePropsContext';

	params.forEach((p) => {
		if (
			(p.type === 'ObjectPattern' || p.type === 'Identifier') &&
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

	const program = root.closest(j.Program);

	const programNode = program.paths()[0] ?? null;

	if (programNode === null) {
		return [false, []];
	}

	const lastImportDeclarationIndex = findLastIndex(
		programNode.value.body,
		(node) => node.type === 'ImportDeclaration',
	);

	const insertPosition =
		lastImportDeclarationIndex === -1 ? 0 : lastImportDeclarationIndex + 1;

	programNode.value.body.splice(
		insertPosition,
		0,
		getDataFunctionDeclaration,
	);

	return [
		true,
		[
			[
				addImportStatement,
				root.closest(j.File),
				{ statement: contextTypeName },
			],
		],
	];
};

// @TODO fix code duplication
export const findGetStaticPropsFunctionDeclarations: ModFunction<
	File,
	'read'
> = (j, root, settings) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const functionDeclarations = root.find(j.FunctionDeclaration, {
		id: {
			type: 'Identifier',
			name: 'getStaticProps',
		},
	});

	functionDeclarations.forEach((functionDeclarationPath) => {
		const functionDeclarationCollection = j(functionDeclarationPath);

		lazyModFunctions.push(
			[
				addGetDataFunction,
				functionDeclarationCollection,
				{ ...settings, methodName: 'getStaticProps' },
			],
			[findReturnStatements, functionDeclarationCollection, settings],
			[
				findComponentFunctionDefinition,
				root,
				{ name: '', includeParams: settings.includeParams },
			],
		);
	});

	return [false, lazyModFunctions];
};

// @TODO fix code duplication
export const findGetStaticPropsArrowFunctions: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const arrowFunctionCollection = root
		.find(j.VariableDeclarator, {
			id: {
				type: 'Identifier',
				name: 'getStaticProps',
			},
		})
		.find(j.ArrowFunctionExpression);

	arrowFunctionCollection.forEach((arrowFunctionPath) => {
		const arrowFunctionCollection = j(arrowFunctionPath);

		// only direct child of variableDeclarator
		if (arrowFunctionPath.parent?.value?.id?.name !== 'getStaticProps') {
			return;
		}

		lazyModFunctions.push(
			[
				addGetDataFunction,
				arrowFunctionCollection,
				{ ...settings, methodName: 'getStaticProps' },
			],
			[findReturnStatements, arrowFunctionCollection, settings],
			[
				findComponentFunctionDefinition,
				root,
				{ name: '', includeParams: settings.includeParams },
			],
		);
	});

	return [false, lazyModFunctions];
};

// @TODO fix code duplication
export const findGetServerSidePropsFunctionDeclarations: ModFunction<
	File,
	'read'
> = (j, root, settings) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.FunctionDeclaration, {
		id: {
			type: 'Identifier',
			name: 'getServerSideProps',
		},
	}).forEach((functionDeclarationPath) => {
		const functionDeclarationCollection = j(functionDeclarationPath);

		lazyModFunctions.push(
			[
				addGetDataFunction,
				functionDeclarationCollection,
				{ ...settings, methodName: 'getServerSideProps' },
			],
			[findReturnStatements, functionDeclarationCollection, settings],
			[
				findComponentFunctionDefinition,
				root,
				{ name: '', includeParams: settings.includeParams },
			],
		);
	});

	return [false, lazyModFunctions];
};

// @TODO fix code duplication
export const findGetServerSidePropsArrowFunctions: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const arrowFunctionCollection = root
		.find(j.VariableDeclarator, {
			id: {
				type: 'Identifier',
				name: 'getServerSideProps',
			},
		})
		.find(j.ArrowFunctionExpression);

	arrowFunctionCollection.forEach((arrowFunctionPath) => {
		const arrowFunctionCollection = j(arrowFunctionPath);

		// only direct child of variableDeclarator
		if (
			arrowFunctionPath.parent?.value?.id?.name !== 'getServerSideProps'
		) {
			return;
		}

		lazyModFunctions.push(
			[
				addGetDataFunction,
				arrowFunctionCollection,
				{ ...settings, methodName: 'getServerSideProps' },
			],
			[findReturnStatements, arrowFunctionCollection, settings],
			[
				findComponentFunctionDefinition,
				root,
				{ name: '', includeParams: settings.includeParams },
			],
		);
	});

	return [false, lazyModFunctions];
};

// @TODO fix code duplication
export const findGetStaticPathsFunctionDeclarations: ModFunction<
	File,
	'read'
> = (j, root, settings) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.FunctionDeclaration, {
		id: {
			type: 'Identifier',
			name: 'getStaticPaths',
		},
	}).forEach((functionDeclarationPath) => {
		const functionDeclarationCollection = j(functionDeclarationPath);

		const newSettings = { ...settings, methodName: 'getStaticPaths' };

		lazyModFunctions.push(
			[
				renameGetStaticPathsFunctionDeclaration,
				functionDeclarationCollection,
				newSettings,
			],
			[findReturnStatements, functionDeclarationCollection, newSettings],
			[addGenerateStaticParamsFunctionDeclaration, root, newSettings],
			[addPageParamsTypeAlias, root, newSettings],
		);
	});

	return [false, lazyModFunctions];
};
// @TODO fix code duplication
export const findGetStaticPathsArrowFunctions: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const variableDeclaratorCollection = root.find(j.VariableDeclarator, {
		id: {
			type: 'Identifier',
			name: 'getStaticPaths',
		},
	});

	const arrowFunctionCollection = variableDeclaratorCollection.find(
		j.ArrowFunctionExpression,
	);

	arrowFunctionCollection.forEach((arrowFunctionPath) => {
		const arrowFunctionCollection = j(arrowFunctionPath);

		// only direct child of variableDeclarator
		if (arrowFunctionPath.parent?.value?.id?.name !== 'getStaticPaths') {
			return;
		}

		const newSettings = { ...settings, methodName: 'getStaticPaths' };

		lazyModFunctions.push(
			[
				renameGetStaticPathsArrowFunction,
				variableDeclaratorCollection,
				newSettings,
			],
			[findReturnStatements, arrowFunctionCollection, newSettings],
			[addGenerateStaticParamsFunctionDeclaration, root, newSettings],
			[addPageParamsTypeAlias, root, newSettings],
		);
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

export const addGetXFunctionDefinition: ModFunction<File, 'write'> = (
	j,
	root,
	settings,
) => {
	const name = 'name' in settings ? String(settings.name) ?? '' : '';

	const params = [];

	if (settings.includeParams) {
		params.push(serverHookParamsFactory(j));
	}

	const identifierName = name
		.split('')
		.map((character, i) => (i == 0 ? character.toUpperCase() : character))
		.join('');

	const functionDeclaration = j.functionDeclaration.from({
		async: true,
		body: j.blockStatement([]),
		id: j.identifier(`get${identifierName}`),
		comments: [j.commentLine(' TODO: implement this function')],
		params,
	});

	let dirtyFlag = false;

	root.find(j.Program).forEach((program) => {
		dirtyFlag = true;

		const lastImportDeclarationIndex = findLastIndex(
			program.value.body,
			(node) => node.type === 'ImportDeclaration',
		);

		const functionDeclarationAlreadyExists =
			program.value.body.findIndex((node) => {
				return (
					node.type === 'FunctionDeclaration' &&
					node.id?.type === 'Identifier' &&
					node.id?.name === `get${identifierName}`
				);
			}) !== -1;

		if (functionDeclarationAlreadyExists) {
			return;
		}

		const insertPosition =
			lastImportDeclarationIndex === -1
				? 0
				: lastImportDeclarationIndex + 1;

		program.value.body.splice(insertPosition, 0, functionDeclaration);
	});

	return [dirtyFlag, []];
};

export const findComponentFunctionDefinition: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	// @TODO component can be arrow function
	// @TODO get Component from the DefaultExport (more reliable)
	root.find(j.FunctionDeclaration, {
		id: {
			type: 'Identifier',
		},
	}).forEach((functionDeclarationPath) => {
		const functionDeclaration = functionDeclarationPath.value;

		if (functionDeclaration.id?.type !== 'Identifier') {
			return;
		}

		const firstCharacter = functionDeclaration.id.name.charAt(0);

		if (firstCharacter !== firstCharacter.toUpperCase()) {
			return;
		}

		const functionDeclarationCollection = j(functionDeclarationPath);

		lazyModFunctions.push([
			findObjectPatternsWithFunctionParameters,
			functionDeclarationCollection,
			settings,
		]);
	});

	return [false, lazyModFunctions];
};

export const addVariableDeclarations: ModFunction<ObjectProperty, 'write'> = (
	j,
	root,
	settings,
) => {
	const objectExpression = j.objectExpression([
		j.objectProperty.from({
			key: j.identifier('params'),
			value: j.identifier('params'),
			shorthand: true,
		}),
	]);

	const objectProperties: ObjectProperty[] = [];

	root.forEach((objectPropertyPath) => {
		objectProperties.push(
			j.objectProperty.from({
				...objectPropertyPath.value,
				shorthand: true,
			}),
		);
	});

	const variableDeclaration = j.variableDeclaration('const', [
		j.variableDeclarator(
			j.objectPattern(objectProperties),
			j.awaitExpression(
				j.callExpression(j.identifier(`getData`), [objectExpression]),
			),
		),
	]);

	const functionDeclaration =
		settings.component as Collection<FunctionDeclaration>;

	let addedVariableDeclaration = false;
	functionDeclaration.find(j.BlockStatement).forEach((blockStatementPath) => {
		const blockStatement = blockStatementPath.value;
		// only add variableDeclaration to blackStatement if its direct child of the FunctionDeclaration
		if (blockStatementPath.parentPath !== functionDeclaration.paths()[0]) {
			return;
		}

		blockStatement.body.unshift(variableDeclaration);
		addedVariableDeclaration = true;
	});

	functionDeclaration.forEach((functionDeclarationPath) => {
		if (addedVariableDeclaration && !functionDeclarationPath.value.async) {
			functionDeclarationPath.value.async = true;
		}
	});

	return [true, []];
};

export const findObjectPatternsWithFunctionParameters: ModFunction<
	FunctionDeclaration,
	'read'
> = (j, root, settings) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.ObjectPattern)
		.filter(
			(path) =>
				(path.parentPath.node.type === 'FunctionDeclaration' ||
					path.parentPath.node.type === 'ArrowFunctionExpression') &&
				path.parentPath.name === 'params',
		)
		.forEach((objectPatternPath) => {
			const objectPatternCollection = j(objectPatternPath);

			lazyModFunctions.push([
				findObjectPropertiesWithinFunctionParameters,
				objectPatternCollection,
				{ ...settings, component: root },
			]);
		});

	return [false, lazyModFunctions];
};

// @TODO
function deepCopyObjectPattern(j: JSCodeshift, objectPattern: ObjectPattern) {
	const newObjectPattern = j.objectPattern([]);

	objectPattern.properties.forEach((property) => {
		if (!('value' in property)) {
			return;
		}

		if (property.value.type === 'ObjectPattern') {
			const newValue = deepCopyObjectPattern(j, property.value);

			newObjectPattern.properties.push(
				j.objectProperty.from({
					key: property.key,
					value: newValue,
					shorthand: true,
				}),
			);

			return;
		}

		newObjectPattern.properties.push(
			j.objectProperty.from({
				key: property.key,
				value: property.value,
				shorthand: true,
			}),
		);
	});

	return newObjectPattern;
}
export const findObjectPropertiesWithinFunctionParameters: ModFunction<
	ObjectPattern,
	'read'
> = (j, root, settings) => {
	root.forEach((objectPatternPath) => {
		const paramsProperty = root.find(j.ObjectProperty, {
			key: {
				type: 'Identifier',
				name: 'params',
			},
		});

		if (paramsProperty.length === 0) {
			const props = objectPatternPath.value.properties;

			const newProperty = j.property.from({
				kind: 'init',
				key: j.identifier('params'),
				shorthand: true,
				value: j.identifier('params'),
			});

			props.push(newProperty);

			// root.forEach((rootPath) => {
			// 	rootPath.value.typeAnnotation = j.tsTypeAnnotation(
			// 		j.tsTypeReference(j.identifier('PageProps')),
			// 	);
			// });
		}
	});

	const objectPropertyCollection = root.find(j.ObjectProperty, {
		key: {
			type: 'Identifier',
		},
	});

	const lazyModFunctions: LazyModFunction[] = [];

	const objectPattern = root.paths()[0] ?? null;

	if (!objectPattern) {
		return [false, []];
	}

	const clonedObjectPattern = deepCopyObjectPattern(j, objectPattern.value);

	const properties = clonedObjectPattern.properties.filter(
		(p) =>
			p.type === 'ObjectProperty' &&
			p.key.type === 'Identifier' &&
			!['params', 'searchParams'].includes(p.key.name),
	);

	lazyModFunctions.push([addVariableDeclarations, j(properties), settings]);

	lazyModFunctions.push([
		removeCollection,
		objectPropertyCollection,
		settings,
	]);

	return [false, lazyModFunctions];
};

export const removeCollection: ModFunction<any, 'write'> = (_, root, __) => {
	if (!root.length) {
		return [false, []];
	}

	root.remove();

	return [true, []];
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
		[findGetStaticPropsFunctionDeclarations, root, settings],
		[findGetStaticPropsArrowFunctions, root, settings],
		[findGetServerSidePropsFunctionDeclarations, root, settings],
		[findGetServerSidePropsArrowFunctions, root, settings],
		[findGetStaticPathsFunctionDeclarations, root, settings],
		[findGetStaticPathsArrowFunctions, root, settings],
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
