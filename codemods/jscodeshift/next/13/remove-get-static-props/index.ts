import type {
	API,
	Collection,
	FileInfo,
	FunctionDeclaration,
	JSCodeshift,
	Options,
	Transform,
} from 'jscodeshift';

type ModFunction<T, D extends 'read' | 'write'> = (
	j: JSCodeshift,
	root: Collection<T>,
	settings: Partial<Record<string, string>>,
) => [D extends 'write' ? boolean : false, ReadonlyArray<LazyModFunction>];

type LazyModFunction = [
	ModFunction<any, 'read' | 'write'>,
	Collection<any>,
	Partial<Record<string, string>>,
];

export const findGetStaticPropsFunctions: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.FunctionDeclaration, {
		id: {
			type: 'Identifier',
			name: 'getStaticProps',
		},
	}).forEach((functionDeclarationPath) => {
		const functionDeclarationCollection = j(functionDeclarationPath);

		lazyModFunctions.push(
			[findReturnStatements, functionDeclarationCollection, settings],
			[
				addCommentOnFunctionDeclaration,
				functionDeclarationCollection,
				settings,
			],
		);
	});

	return [false, lazyModFunctions];
};

export const addCommentOnFunctionDeclaration: ModFunction<
	FunctionDeclaration,
	'write'
> = (j, root, settings) => {
	const lazyModFunctions: LazyModFunction[] = [];
	let dirtyFlag = false;

	root.forEach((functionDeclarationPath) => {
		dirtyFlag = true;

		functionDeclarationPath.value.comments = [
			...(functionDeclarationPath.value.comments ?? []),
			j.commentLine(' TODO: remove this function'),
		];
	});

	return [dirtyFlag, lazyModFunctions];
};

export const findReturnStatements: ModFunction<FunctionDeclaration, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.ReturnStatement).forEach((returnStatementPath) => {
		const returnStatementCollection = j(returnStatementPath);

		lazyModFunctions.push([
			findPropsObjectProperty,
			returnStatementCollection,
			settings,
		]);
	});

	return [false, lazyModFunctions];
};

export const findPropsObjectProperty: ModFunction<any, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	root.find(j.ObjectProperty, {
		key: {
			type: 'Identifier',
			name: 'props',
		},
	}).forEach((objectPropertyPath) => {
		const objectPropertyCollection = j(objectPropertyPath);

		lazyModFunctions.push([
			findObjectProperties,
			objectPropertyCollection,
			settings,
		]);
	});

	return [false, lazyModFunctions];
};

export const findObjectProperties: ModFunction<any, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

	const fileCollection = root.closest(j.File);

	root.find(j.ObjectProperty, {
		key: {
			type: 'Identifier',
		},
	}).forEach((objectPropertyPath, i) => {
		if (i !== 0) {
			return;
		}

		const objectProperty = objectPropertyPath.value;

		if (objectProperty.key.type !== 'Identifier') {
			return;
		}

		const { name } = objectProperty.key;

		lazyModFunctions.push(
			[
				addGetXFunctionDefinition,
				fileCollection,
				{
					name,
				},
			],
			[
				findComponentFunctionDefinition,
				fileCollection,
				{
					name,
				},
			],
		);
	});

	return [false, lazyModFunctions];
};

export const addGetXFunctionDefinition: ModFunction<File, 'write'> = (
	j,
	root,
	settings,
) => {
	const name = 'name' in settings ? settings.name ?? '' : '';

	const identifierName = name
		.split('')
		.map((character, i) => (i == 0 ? character.toUpperCase() : character))
		.join('');

	const functionDeclaration = j.functionDeclaration.from({
		async: true,
		body: j.blockStatement([]),
		id: j.identifier(`get${identifierName}`),
		comments: [j.commentLine(' TODO: implement this function')],
		params: [],
	});

	let dirtyFlag = false;

	root.find(j.Program).forEach((program) => {
		dirtyFlag = true;

		program.value.body.unshift(functionDeclaration);
	});

	return [dirtyFlag, []];
};

export const findComponentFunctionDefinition: ModFunction<File, 'read'> = (
	j,
	root,
	settings,
) => {
	const lazyModFunctions: LazyModFunction[] = [];

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

		console.log(functionDeclaration.id, settings);
	});

	return [false, lazyModFunctions];
};

export default function transform(
	file: FileInfo,
	api: API,
	options: Options,
): string | undefined {
	const j = api.jscodeshift;

	let dirtyFlag = false;

	const root = j(file.source);
	const settings = {};

	const lazyModFunctions: LazyModFunction[] = [
		[findGetStaticPropsFunctions, root, settings],
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