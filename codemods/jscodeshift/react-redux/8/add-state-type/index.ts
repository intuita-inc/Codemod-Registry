import {
	API,
	Collection,
	FileInfo,
	JSCodeshift,
	Options,
	Transform,
} from 'jscodeshift';

type Settings = {
	stateTypeIdentifierName: string;
	stateSourceLiteralValue: string;
};

type AtomicMod = (
	j: JSCodeshift,
	root: Collection<any>,
	settings: Settings,
) => [boolean, ReadonlyArray<LazyAtomicMod>];

type LazyAtomicMod = [AtomicMod, JSCodeshift, Collection<any>, Settings];

export const upsertTypeAnnotationOnStateParameterOfMapStateToProps: AtomicMod =
	(j, root, settings) => {
		let dirtyFlag: boolean = false;

		root.find(j.VariableDeclarator, {
			id: {
				type: 'Identifier',
				name: 'mapStateToProps',
			},
			init: {
				type: 'ArrowFunctionExpression',
			},
		}).forEach((variableDeclaratorPath) => {
			j(variableDeclaratorPath)
				.find(j.ArrowFunctionExpression)
				.filter((arrowFunctionExpressionPath) => {
					return (
						arrowFunctionExpressionPath.value.params.length !== 0
					);
				})
				.forEach((arrowFunctionExpressionPath) => {
					const patternKind =
						arrowFunctionExpressionPath.value.params[0];

					if (patternKind?.type !== 'Identifier') {
						return;
					}

					const identifierCollection = j(
						arrowFunctionExpressionPath,
					).find(j.Identifier, {
						name: patternKind.name,
					});

					const typeAnnotation = j.typeAnnotation(
						j.genericTypeAnnotation(
							j.identifier(settings.stateTypeIdentifierName),
							null,
						),
					);

					dirtyFlag = true;

					// this uses the fact that the state parameter must be the first
					// found indentifier under the arrow-function-expression
					identifierCollection.paths()[0]?.replace(
						j.identifier.from({
							name: patternKind.name,
							typeAnnotation,
						}),
					);
				});
		});

		if (!dirtyFlag) {
			return [dirtyFlag, []];
		}

		return [true, [[addImportStatement, j, root, settings]]];
	};

export const addImportStatement: AtomicMod = (
	j: JSCodeshift,
	root: Collection<any>,
	settings,
) => {
	const importDeclaration = j.importDeclaration(
		[
			j.importSpecifier(
				j.identifier(settings.stateTypeIdentifierName),
				j.identifier(settings.stateTypeIdentifierName),
			),
		],
		j.stringLiteral(settings.stateSourceLiteralValue),
	);

	root.find(j.Program).forEach((programPath) => {
		programPath.value.body.unshift(importDeclaration);
	});

	return [true, []];
};

export default function transform(file: FileInfo, api: API, jOptions: Options) {
	const j = api.jscodeshift;

	let dirtyFlag = false;

	const root = j(file.source);

	const settings = {
		stateTypeIdentifierName:
			'stateTypeIdentifierName' in jOptions
				? String(jOptions.stateTypeIdentifierName)
				: 'State',
		stateSourceLiteralValue:
			'stateSourceLiteralValue' in jOptions
				? String(jOptions.stateSourceLiteralValue)
				: 'state',
	};

	const lazyAtomicMods: LazyAtomicMod[] = [
		[
			upsertTypeAnnotationOnStateParameterOfMapStateToProps,
			j,
			root,
			settings,
		],
	];

	while (true) {
		const last = lazyAtomicMods.pop();

		if (!last) {
			break;
		}

		const [newDirtyFlag, newMods] = last[0](last[1], last[2], last[3]);

		dirtyFlag ||= newDirtyFlag;

		// newMods: 0, 1, 2
		// 2, 1, 0 so 0 gets picked first

		for (const newMod of newMods) {
			lazyAtomicMods.unshift(newMod);
		}
	}

	if (!dirtyFlag) {
		return undefined;
	}

	return root.toSource();
}

transform satisfies Transform;
