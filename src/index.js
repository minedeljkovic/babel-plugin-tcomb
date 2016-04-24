const tcombLibraries = {
  'tcomb': 1,
  'tcomb-validation': 1,
  'tcomb-react': 1,
  'tcomb-form': 1
};

export default function ({ types: t }) {

  let tcombLocalName = 't';

  function getExpressionFromGenericTypeAnnotation(id) {
    if (id.type === 'QualifiedTypeIdentifier') {
      return t.memberExpression(getExpressionFromGenericTypeAnnotation(id.qualification), t.identifier(id.id.name));
    }
    return t.identifier(id.name);
  }

  function getList(node) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('list')),
      [getType(node)]
    );
  }

  function getMaybe(node) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('maybe')),
      [getType(node)]
    );
  }

  function getTuple(nodes) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('tuple')),
      [t.arrayExpression(nodes.map(getType))]
    );
  }

  function getUnion(nodes) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('union')),
      [t.arrayExpression(nodes.map(getType))]
    );
  }

  function getDict(key, value) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('dict')),
      [getType(key), getType(value)]
    );
  }

  function getIntersection(nodes) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('intersection')),
      [t.arrayExpression(nodes.map(getType))]
    );
  }

  function getFunc(domain, codomain) {
    return t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('func')),
      [t.arrayExpression(domain.map(getType)), getType(codomain)]
    );
  }

  function getType(annotation) {
    switch (annotation.type) {

      case 'GenericTypeAnnotation' :
        if (annotation.id.name === 'Array') {
          if (!annotation.typeParameters || annotation.typeParameters.params.length !== 1) {
            throw new SyntaxError(`Unsupported Array type annotation`);
          }
          return getList(annotation.typeParameters.params[0]);
        }
        return getExpressionFromGenericTypeAnnotation(annotation.id);

      case 'ArrayTypeAnnotation' :
        return getList(annotation.elementType);

      case 'NullableTypeAnnotation' :
        return getMaybe(annotation.typeAnnotation);

      case 'TupleTypeAnnotation' :
        return getTuple(annotation.types);

      case 'UnionTypeAnnotation' :
        return getUnion(annotation.types);

      case 'ObjectTypeAnnotation' :
        if (annotation.indexers.length === 1) {
          return getDict(annotation.indexers[0].key, annotation.indexers[0].value);
        }
        throw new SyntaxError(`Unsupported Object type annotation`);

      case 'IntersectionTypeAnnotation' :
        return getIntersection(annotation.types);

      case 'FunctionTypeAnnotation' :
        return getFunc(annotation.params.map((param) => param.typeAnnotation), annotation.returnType);

      default :
        throw new SyntaxError(`Unsupported type annotation: ${annotation.type}`);
    }
  }

  function getAssert(typeAnnotation, id) {
    const is = t.callExpression(
      t.memberExpression(getType(typeAnnotation), t.identifier('is')),
      [id]
    );
    const assert = t.callExpression(
      t.memberExpression(t.identifier(tcombLocalName), t.identifier('assert')),
      [is]
    );
    return t.expressionStatement(assert);
  }

  function getFunctionArgumentCheckExpressions(node) {

    function getTypeAnnotation(param) {
      if (param.type === 'AssignmentPattern') {
        if (param.left.typeAnnotation) {
          throw new SyntaxError('Typed default values are not supported');
        }
      }
      return param.typeAnnotation;
    }

    return node.params.filter(getTypeAnnotation).map((param) => {
      const id = t.identifier(param.name);
      const typeAnnotation = getTypeAnnotation(param);
      return getAssert(typeAnnotation.typeAnnotation, id);
    })
  }

  function getWrappedFunctionReturnWithTypeCheck(node) {
    const params = node.params.map((param) => t.identifier(param.name));
    const id = t.identifier('ret');

    return [
      t.variableDeclaration('var', [
        t.variableDeclarator(
          id,
          t.callExpression(
            t.memberExpression(t.functionExpression(null, params, node.body), t.identifier('call')),
            [t.identifier('this')].concat(params)
          )
        )
      ]),
      getAssert(node.returnType.typeAnnotation, id),
      t.returnStatement(id)
    ];
  }

  function getTcombLocalNameFromImports(node) {
    for (let i = 0, len = node.specifiers.length ; i < len ; i++) {
      if (node.specifiers[i].type === 'ImportDefaultSpecifier') {
        return node.specifiers[i].local.name;
      }
    }
  }

  return {
    visitor: {

      File: {
        enter() {
          tcombLocalName = 't'; // reset;
        }
      },

      ImportDeclaration({ node }) {
        if (tcombLibraries.hasOwnProperty(node.source.value)) {
          tcombLocalName = getTcombLocalNameFromImports(node);
        }
      },

      Function(path) {
        const { node } = path;

        try {
          // Firstly let's replace arrow function expressions into
          // block statement return structures.
          if (node.type === "ArrowFunctionExpression" && node.expression) {
            node.expression = false;
            node.body = t.blockStatement([t.returnStatement(node.body)]);
          }

          // If we have a return type then we will wrap our entire function
          // body and insert a type check on the returned value.
          if (node.returnType) {
            const funcBody = path.get('body');

            funcBody.replaceWithMultiple(
              getWrappedFunctionReturnWithTypeCheck(node, tcombLocalName)
            );
          }

          // Prepend any argument checks to the top of our function body.
          const argumentChecks = getFunctionArgumentCheckExpressions(
            node,
            tcombLocalName
          );
          if (argumentChecks.length > 0) {
            node.body.body.unshift(...argumentChecks);
          }
        }
        catch (e) {
          if (e instanceof SyntaxError) {
            throw new Error('[babel-plugin-tcomb] ' + e.message);
          }
          else {
            throw e;
          }
        }
      }
    }
  };
}
