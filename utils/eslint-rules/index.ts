import type { Rule } from "eslint";

export const noMarginUtilities: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Use padding and layout gaps instead of margin utilities",
    },
    messages: {
      margin:
        "Replace '{{utility}}' with padding, a layout gap, or a wrapper. Auto margins are allowed.",
    },
    schema: [],
  },
  create(context) {
    function check(node: Rule.Node, value: string) {
      let parent = node.parent;

      while (parent && parent.type !== "JSXAttribute") {
        parent = parent.parent;
      }

      if (parent?.type !== "JSXAttribute" || parent.name.name !== "className") {
        return;
      }

      for (const token of value.split(/\s+/)) {
        const utility = token.split(":").at(-1)?.replace(/^!|!$/g, "") ?? "";

        if (
          /^-?(?:m[trblxyse]?|space-[xy])-/.test(utility) &&
          !/^m[trblxyse]?-auto$/.test(utility)
        ) {
          context.report({
            node,
            messageId: "margin",
            data: { utility: token },
          });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};

export const noReactNamespaceImport: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require named imports from React",
    },
    messages: {
      namespaceImport:
        "Import only the React exports used by this module instead of using a namespace import.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (
          node.source.value === "react" &&
          node.specifiers.some(
            (specifier) => specifier.type === "ImportNamespaceSpecifier",
          )
        ) {
          context.report({ node, messageId: "namespaceImport" });
        }
      },
    };
  },
};

function isPropertyNamed(
  member: {
    computed: boolean;
    property: { type: string; name?: string; value?: unknown };
  },
  name: string,
): boolean {
  return member.computed
    ? member.property.type === "Literal" && member.property.value === name
    : member.property.type === "Identifier" && member.property.name === name;
}

export const noWindowLocationReload: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow reloads that bypass TanStack Router",
    },
    messages: {
      reload:
        "Do not use window.location.reload(); use TanStack Router navigation instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;

        if (
          callee.type !== "MemberExpression" ||
          !isPropertyNamed(callee, "reload") ||
          callee.object.type !== "MemberExpression" ||
          !isPropertyNamed(callee.object, "location") ||
          callee.object.object.type !== "Identifier" ||
          callee.object.object.name !== "window"
        ) {
          return;
        }

        context.report({ node, messageId: "reload" });
      },
    };
  },
};

interface AstNode {
  type: string;
  parent: AstNode | null;
  range: [number, number];
}

interface TypeAliasDeclaration extends AstNode {
  type: "TSTypeAliasDeclaration";
  typeAnnotation: AstNode;
  typeParameters?: unknown;
}

interface FunctionDeclaration extends AstNode {
  type: "FunctionDeclaration";
  async: boolean;
  generator: boolean;
  params: AstNode[];
  body: AstNode & { body: AstNode[] };
}

interface ReturnStatement extends AstNode {
  type: "ReturnStatement";
  argument: AstNode | null;
}

function isExported(node: AstNode): boolean {
  return (
    node.parent?.type === "ExportNamedDeclaration" ||
    node.parent?.type === "ExportDefaultDeclaration"
  );
}

function containsContextSensitiveNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const node = value as { type?: string; [key: string]: unknown };

  if (
    node.type === "ThisExpression" ||
    node.type === "Super" ||
    node.type === "MetaProperty"
  ) {
    return true;
  }

  return Object.entries(node).some(
    ([key, child]) =>
      key !== "parent" &&
      key !== "loc" &&
      key !== "range" &&
      containsContextSensitiveNode(child),
  );
}

const unambiguousInlineTypes = new Set([
  "TSAnyKeyword",
  "TSBigIntKeyword",
  "TSBooleanKeyword",
  "TSIntrinsicKeyword",
  "TSLiteralType",
  "TSNeverKeyword",
  "TSNullKeyword",
  "TSNumberKeyword",
  "TSObjectKeyword",
  "TSStringKeyword",
  "TSSymbolKeyword",
  "TSThisType",
  "TSTupleType",
  "TSTypeLiteral",
  "TSTypeReference",
  "TSUndefinedKeyword",
  "TSUnknownKeyword",
  "TSVoidKeyword",
]);

export const inlineSingleUseDeclarations: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Inline local types and functions that are used only once",
    },
    fixable: "code",
    messages: {
      function: "Inline this function at its only call site.",
      type: "Inline this type at its only use site.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      TSTypeAliasDeclaration(untypedNode: Rule.Node) {
        const node = untypedNode as unknown as TypeAliasDeclaration;

        if (node.typeParameters || isExported(node)) return;

        const eslintNode = node as unknown as Rule.Node;
        const [variable] = sourceCode.getDeclaredVariables(eslintNode);

        if (!variable || variable.references.length !== 1) return;

        const reference = variable.references[0]
          .identifier as unknown as AstNode;

        if (
          reference.range[0] >= node.range[0] &&
          reference.range[1] <= node.range[1]
        ) {
          return;
        }

        const referenceParent = reference.parent;

        if (
          !referenceParent ||
          referenceParent.type !== "TSTypeReference" ||
          referenceParent.parent?.type === "TSClassImplements" ||
          referenceParent.parent?.type === "TSInterfaceHeritage"
        ) {
          return;
        }

        context.report({
          node: eslintNode,
          messageId: "type",
          fix(fixer) {
            const annotation = sourceCode.getText(
              node.typeAnnotation as unknown as Rule.Node,
            );
            const replacement = unambiguousInlineTypes.has(
              node.typeAnnotation.type,
            )
              ? annotation
              : `(${annotation})`;

            return [
              fixer.replaceText(
                referenceParent as unknown as Rule.Node,
                replacement,
              ),
              fixer.remove(eslintNode),
            ];
          },
        });
      },

      FunctionDeclaration(untypedNode: Rule.Node) {
        const node = untypedNode as unknown as FunctionDeclaration;

        if (
          node.async ||
          node.generator ||
          node.params.length !== 0 ||
          node.body.body.length !== 1 ||
          isExported(node)
        ) {
          return;
        }

        const statement = node.body.body[0] as ReturnStatement;

        if (statement.type !== "ReturnStatement" || !statement.argument) return;

        const eslintNode = node as unknown as Rule.Node;
        const functionScope = sourceCode.getScope(eslintNode);

        if (
          functionScope.references.length !== 0 ||
          functionScope.through.length !== 0 ||
          containsContextSensitiveNode(statement.argument)
        ) {
          return;
        }

        const [variable] = sourceCode.getDeclaredVariables(eslintNode);

        if (!variable || variable.references.length !== 1) return;

        const reference = variable.references[0]
          .identifier as unknown as AstNode;
        const call = reference.parent;

        if (
          !call ||
          call.type !== "CallExpression" ||
          (call as AstNode & { callee: AstNode }).callee !== reference ||
          (call as AstNode & { arguments: AstNode[] }).arguments.length !== 0 ||
          (call as AstNode & { optional?: boolean }).optional ||
          (reference.range[0] >= node.range[0] &&
            reference.range[1] <= node.range[1])
        ) {
          return;
        }

        context.report({
          node: eslintNode,
          messageId: "function",
          fix(fixer) {
            const expression = sourceCode.getText(
              statement.argument! as unknown as Rule.Node,
            );
            const replacement =
              statement.argument!.type === "Literal"
                ? expression
                : `(${expression})`;

            return [
              fixer.replaceText(call as unknown as Rule.Node, replacement),
              fixer.remove(eslintNode),
            ];
          },
        });
      },
    };
  },
};
