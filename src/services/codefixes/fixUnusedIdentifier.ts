/* @internal */
namespace ts.codefix {
    const fixName = "unusedIdentifier";
    const fixIdPrefix = "unusedIdentifier_prefix";
    const fixIdDelete = "unusedIdentifier_delete";
    const fixIdInfer = "unusedIdentifier_infer";
    const errorCodes = [
        Diagnostics._0_is_declared_but_its_value_is_never_read.code,
        Diagnostics._0_is_declared_but_never_used.code,
        Diagnostics.Property_0_is_declared_but_its_value_is_never_read.code,
        Diagnostics.All_imports_in_import_declaration_are_unused.code,
        Diagnostics.All_destructured_elements_are_unused.code,
        Diagnostics.All_variables_are_unused.code,
        Diagnostics.All_type_parameters_are_unused.code,
    ];

    registerCodeFix({
        errorCodes,
        getCodeActions(context) {
            const { errorCode, sourceFile, program } = context;
            const checker = program.getTypeChecker();
            const sourceFiles = program.getSourceFiles();
            const token = getTokenAtPosition(sourceFile, context.span.start);

            if (isJSDocTemplateTag(token)) {
                return [createDeleteFix(textChanges.ChangeTracker.with(context, t => t.delete(sourceFile, token)), Diagnostics.Remove_template_tag)];
            }
            if (token.kind === SyntaxKind.LessThanToken) {
                const changes = textChanges.ChangeTracker.with(context, t => deleteTypeParameters(t, sourceFile, token));
                return [createDeleteFix(changes, Diagnostics.Remove_type_parameters)];
            }
            const importDecl = tryGetFullImport(token);
            if (importDecl) {
                const changes = textChanges.ChangeTracker.with(context, t => t.delete(sourceFile, importDecl));
                return [createDeleteFix(changes, [Diagnostics.Remove_import_from_0, showModuleSpecifier(importDecl)])];
            }

            if (isObjectBindingPattern(token.parent)) {
                if (isParameter(token.parent.parent)) {
                    const elements = token.parent.elements;
                    const diagnostic: [DiagnosticMessage, string] = [
                        elements.length > 1 ? Diagnostics.Remove_unused_declarations_for_Colon_0 : Diagnostics.Remove_unused_declaration_for_Colon_0,
                        map(elements, e => e.getText(sourceFile)).join(", ")
                    ];
                    return [
                        createDeleteFix(textChanges.ChangeTracker.with(context, t =>
                            deleteDestructuringElements(t, sourceFile, <ObjectBindingPattern>token.parent)), diagnostic)
                    ];
                }
                return [
                    createDeleteFix(textChanges.ChangeTracker.with(context, t =>
                        t.delete(sourceFile, token.parent.parent)), Diagnostics.Remove_unused_destructuring_declaration)
                ];
            }

            if (canDeleteEntireVariableStatement(sourceFile, token)) {
                return [
                    createDeleteFix(textChanges.ChangeTracker.with(context, t =>
                        deleteEntireVariableStatement(t, sourceFile, <VariableDeclarationList>token.parent)), Diagnostics.Remove_variable_statement)
                ];
            }

            const result: CodeFixAction[] = [];
            if (token.kind === SyntaxKind.InferKeyword) {
                const changes = textChanges.ChangeTracker.with(context, t => changeInferToUnknown(t, sourceFile, token));
                const name = cast(token.parent, isInferTypeNode).typeParameter.name.text;
                result.push(createCodeFixAction(fixName, changes, [Diagnostics.Replace_infer_0_with_unknown, name], fixIdInfer, Diagnostics.Replace_all_unused_infer_with_unknown));
            }
            else {
                const deletion = textChanges.ChangeTracker.with(context, t =>
                    tryDeleteDeclaration(sourceFile, token, t, checker, sourceFiles, /*isFixAll*/ false));
                if (deletion.length) {
                    const name = isComputedPropertyName(token.parent) ? token.parent : token;
                    result.push(createDeleteFix(deletion, [Diagnostics.Remove_unused_declaration_for_Colon_0, name.getText(sourceFile)]));
                }
            }

            const prefix = textChanges.ChangeTracker.with(context, t => tryPrefixDeclaration(t, errorCode, sourceFile, token));
            if (prefix.length) {
                result.push(createCodeFixAction(fixName, prefix, [Diagnostics.Prefix_0_with_an_underscore, token.getText(sourceFile)], fixIdPrefix, Diagnostics.Prefix_all_unused_declarations_with_where_possible));
            }

            return result;
        },
        fixIds: [fixIdPrefix, fixIdDelete, fixIdInfer],
        getAllCodeActions: context => {
            const { sourceFile, program } = context;
            const checker = program.getTypeChecker();
            const sourceFiles = program.getSourceFiles();
            return codeFixAll(context, errorCodes, (changes, diag) => {
                const token = getTokenAtPosition(sourceFile, diag.start);
                switch (context.fixId) {
                    case fixIdPrefix:
                        tryPrefixDeclaration(changes, diag.code, sourceFile, token);
                        break;
                    case fixIdDelete: {
                        if (token.kind === SyntaxKind.InferKeyword) {
                            break; // Can't delete
                        }
                        const importDecl = tryGetFullImport(token);
                        if (importDecl) {
                            changes.delete(sourceFile, importDecl);
                        }
                        else if (isJSDocTemplateTag(token)) {
                            changes.delete(sourceFile, token);
                        }
                        else if (token.kind === SyntaxKind.LessThanToken) {
                            deleteTypeParameters(changes, sourceFile, token);
                        }
                        else if (isObjectBindingPattern(token.parent)) {
                            if (isAnyBindingPatternElementInitialized(token.parent)) {
                                break;
                            }
                            else if (isParameter(token.parent.parent)) {
                                if (isNotProvidedArguments(token.parent.parent, checker, sourceFiles)) {
                                    deleteDestructuringElements(changes, sourceFile, token.parent);
                                }
                            }
                            else {
                                changes.delete(sourceFile, token.parent.parent);
                            }
                        }
                        else if (canDeleteEntireVariableStatement(sourceFile, token)) {
                            deleteEntireVariableStatement(changes, sourceFile, <VariableDeclarationList>token.parent);
                        }
                        else {
                            tryDeleteDeclaration(sourceFile, token, changes, checker, sourceFiles, /*isFixAll*/ true);
                        }
                        break;
                    }
                    case fixIdInfer:
                        if (token.kind === SyntaxKind.InferKeyword) {
                            changeInferToUnknown(changes, sourceFile, token);
                        }
                        break;
                    default:
                        Debug.fail(JSON.stringify(context.fixId));
                }
            });
        },
    });

    function changeInferToUnknown(changes: textChanges.ChangeTracker, sourceFile: SourceFile, token: Node): void {
        changes.replaceNode(sourceFile, token.parent, factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword));
    }

    function createDeleteFix(changes: FileTextChanges[], diag: DiagnosticAndArguments): CodeFixAction {
        return createCodeFixAction(fixName, changes, diag, fixIdDelete, Diagnostics.Delete_all_unused_declarations);
    }

    function deleteTypeParameters(changes: textChanges.ChangeTracker, sourceFile: SourceFile, token: Node): void {
        changes.delete(sourceFile, Debug.checkDefined(cast(token.parent, isDeclarationWithTypeParameterChildren).typeParameters, "The type parameter to delete should exist"));
    }

    /** Sometimes the diagnostic span is an entire ImportDeclaration, so we should remove the whole thing. */
    function tryGetFullImport(token: Node): ImportDeclaration | undefined {
        return token.kind === SyntaxKind.ImportKeyword ? tryCast(token.parent, isImportDeclaration) : undefined;
    }

    /** Uses a quadratic search for any use of any pattern element, because the error token doesn't specify a single element. */
    function isAnyBindingPatternElementInitialized(pattern: ObjectBindingPattern) {
        if (pattern.parent.initializer && isObjectLiteralExpression(pattern.parent.initializer)) {
            const init = pattern.parent.initializer;
            return some(
                pattern.elements,
                e => some(
                    init.properties,
                    p => !!p.name && isIdentifier(p.name) && isIdentifier(e.name) && p.name.escapedText === e.name.escapedText));
        }
    }

    function canDeleteEntireVariableStatement(sourceFile: SourceFile, token: Node): boolean {
        return isVariableDeclarationList(token.parent) && first(token.parent.getChildren(sourceFile)) === token;
    }

    function deleteEntireVariableStatement(changes: textChanges.ChangeTracker, sourceFile: SourceFile, node: VariableDeclarationList) {
        changes.delete(sourceFile, node.parent.kind === SyntaxKind.VariableStatement ? node.parent : node);
    }

    function deleteDestructuringElements(changes: textChanges.ChangeTracker, sourceFile: SourceFile, node: ObjectBindingPattern) {
        forEach(node.elements, n => changes.delete(sourceFile, n));
    }

    function tryPrefixDeclaration(changes: textChanges.ChangeTracker, errorCode: number, sourceFile: SourceFile, token: Node): void {
        // Don't offer to prefix a property.
        if (errorCode === Diagnostics.Property_0_is_declared_but_its_value_is_never_read.code) return;
        if (token.kind === SyntaxKind.InferKeyword) {
            token = cast(token.parent, isInferTypeNode).typeParameter.name;
        }
        if (isIdentifier(token) && canPrefix(token)) {
            changes.replaceNode(sourceFile, token, factory.createIdentifier(`_${token.text}`));
            if (isParameter(token.parent)) {
                getJSDocParameterTags(token.parent).forEach((tag) => {
                    if (isIdentifier(tag.name)) {
                        changes.replaceNode(sourceFile, tag.name, factory.createIdentifier(`_${tag.name.text}`));
                    }
                });
            }
        }
    }

    function canPrefix(token: Identifier): boolean {
        switch (token.parent.kind) {
            case SyntaxKind.Parameter:
            case SyntaxKind.TypeParameter:
                return true;
            case SyntaxKind.VariableDeclaration: {
                const varDecl = token.parent as VariableDeclaration;
                switch (varDecl.parent.parent.kind) {
                    case SyntaxKind.ForOfStatement:
                    case SyntaxKind.ForInStatement:
                        return true;
                }
            }
        }
        return false;
    }

    function tryDeleteDeclaration(sourceFile: SourceFile, token: Node, changes: textChanges.ChangeTracker, checker: TypeChecker, sourceFiles: readonly SourceFile[], isFixAll: boolean) {
        tryDeleteDeclarationWorker(token, changes, sourceFile, checker, sourceFiles, isFixAll);
        if (isIdentifier(token)) {
            FindAllReferences.Core.eachSymbolReferenceInFile(token, checker, sourceFile, (ref: Node) => {
                if (isPropertyAccessExpression(ref.parent) && ref.parent.name === ref) ref = ref.parent;
                if (!isFixAll && isBinaryExpression(ref.parent) && isExpressionStatement(ref.parent.parent) && ref.parent.left === ref) {
                    changes.delete(sourceFile, ref.parent.parent);
                }
            });
        }
    }

    function tryDeleteDeclarationWorker(token: Node, changes: textChanges.ChangeTracker, sourceFile: SourceFile, checker: TypeChecker, sourceFiles: readonly SourceFile[], isFixAll: boolean): void {
        const { parent } = token;
        if (isParameter(parent)) {
            tryDeleteParameter(changes, sourceFile, parent, checker, sourceFiles, isFixAll);
        }
        else if (!isFixAll || !(isIdentifier(token) && FindAllReferences.Core.isSymbolReferencedInFile(token, checker, sourceFile))) {
            changes.delete(sourceFile, isImportClause(parent) ? token : isComputedPropertyName(parent) ? parent.parent : parent);
        }
    }

    function tryDeleteParameter(
        changes: textChanges.ChangeTracker,
        sourceFile: SourceFile,
        parameter: ParameterDeclaration,
        checker: TypeChecker,
        sourceFiles: readonly SourceFile[],
        isFixAll = false): void {
        if (mayDeleteParameter(checker, sourceFile, parameter, isFixAll)) {
            if (parameter.modifiers && parameter.modifiers.length > 0 &&
                (!isIdentifier(parameter.name) || FindAllReferences.Core.isSymbolReferencedInFile(parameter.name, checker, sourceFile))) {
                parameter.modifiers.forEach(modifier => changes.deleteModifier(sourceFile, modifier));
            }
            else if (!parameter.initializer && isNotProvidedArguments(parameter, checker, sourceFiles)) {
                changes.delete(sourceFile, parameter);
            }
        }
    }

    function isNotProvidedArguments(parameter: ParameterDeclaration, checker: TypeChecker, sourceFiles: readonly SourceFile[]) {
        let isUsed = false;
        const index = parameter.parent.parameters.indexOf(parameter);
        FindAllReferences.Core.eachSignatureCall(parameter.parent, sourceFiles, checker, call => {
            if (call.arguments.length > index) { // Just in case the call didn't provide enough arguments.
                isUsed = true;
            }
        });
        return !isUsed;
    }

    function mayDeleteParameter(checker: TypeChecker, sourceFile: SourceFile, parameter: ParameterDeclaration, isFixAll: boolean): boolean {
        const { parent } = parameter;
        switch (parent.kind) {
            case SyntaxKind.MethodDeclaration:
                // Don't remove a parameter if this overrides something.
                const symbol = checker.getSymbolAtLocation(parent.name)!;
                if (isMemberSymbolInBaseType(symbol, checker)) return false;
                // falls through
            case SyntaxKind.Constructor:
                return true;
            case SyntaxKind.FunctionDeclaration: {
                if (parent.name && isCallbackLike(checker, sourceFile, parent.name)) {
                    return isLastParameter(parent, parameter, isFixAll);
                }
                return true;
            }
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.ArrowFunction:
                // Can't remove a non-last parameter in a callback. Can remove a parameter in code-fix-all if future parameters are also unused.
                return isLastParameter(parent, parameter, isFixAll);

            case SyntaxKind.SetAccessor:
                // Setter must have a parameter
                return false;

            default:
                return Debug.failBadSyntaxKind(parent);
        }
    }

    function isCallbackLike(checker: TypeChecker, sourceFile: SourceFile, name: Identifier): boolean {
        return !!FindAllReferences.Core.eachSymbolReferenceInFile(name, checker, sourceFile, reference =>
            isIdentifier(reference) && isCallExpression(reference.parent) && reference.parent.arguments.indexOf(reference) >= 0);
    }

    function isLastParameter(func: FunctionLikeDeclaration, parameter: ParameterDeclaration, isFixAll: boolean): boolean {
        const parameters = func.parameters;
        const index = parameters.indexOf(parameter);
        Debug.assert(index !== -1, "The parameter should already be in the list");
        return isFixAll ?
            parameters.slice(index + 1).every(p => isIdentifier(p.name) && !p.symbol.isReferenced) :
            index === parameters.length - 1;
    }
}
