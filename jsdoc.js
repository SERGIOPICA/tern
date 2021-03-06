(function(exports) {
  "use strict";

  var infer = typeof require != "undefined" ? require("./infer") : exports;

  exports.gather = function(out) {
    return function(block, text, _start, end) {
      if (!block || !/^\*/.test(text)) return;
      var decl = /(?:\n|\*)\s*@(type|param|arg(?:ument)?|returns?)\s+(.*)/g, m, found = [];
      while (m = decl.exec(text)) {
        var type = m[1];
        if (/^arg/.test(type)) type = "param";
        if (type == "return") type = "returns";
        found.push(type, m[2]);
      }
      if (found.length) out.push({decls: found, at: end});
    };
  };

  function skipSpace(str, pos) {
    while (/\s/.test(str.charAt(pos))) ++pos;
    return pos;
  }

  function parseLabelList(scope, str, pos, close) {
    var labels = [], types = [];
    for (var first = true; ; first = false) {
      pos = skipSpace(str, pos);
      if (first && str.charAt(pos) == close) break;
      var colon = str.indexOf(":", pos);
      if (colon < 0) return null;
      var label = str.slice(pos, colon);
      if (!/^[\w$]+$/.test(label)) return null;
      labels.push(label);
      pos = colon + 1;
      var type = parseType(scope, str, pos);
      if (!type) return null;
      pos = type.end;
      types.push(type.type);
      pos = skipSpace(str, pos);
      var next = str.charAt(pos);
      ++pos;
      if (next == close) break;
      if (next != ",") return null;
    }
    return {labels: labels, types: types, end: pos};
  }

  function parseType(scope, str, pos) {
    pos = skipSpace(str, pos);
    var type;

    if (str.indexOf("function(", pos) == pos) {
      var args = parseLabelList(scope, str, pos + 9, ")"), ret = ANull;
      if (!args) return null;
      pos = skipSpace(str, args.end);
      if (str.charAt(pos) == ":") {
        ++pos;
        var retType = parseType(scope, str, pos + 1);
        if (!retType) return null;
        pos = retType.end;
        ret = retType.type;
      }
      type = new infer.Fn(null, ANull, args.labels, args.types, ret);
    } else if (str.charAt(pos) == "[") {
      var inner = parseType(scope, str, pos + 1);
      if (!inner) return null;
      pos = skipSpace(str, inner.end);
      if (str.charAt(pos) != "]") return null;
      ++pos;
      type = new infer.Arr(inner.type);
    } else if (str.charAt(pos) == "{") {
      var fields = parseLabelList(scope, str, pos + 1, "}");
      if (!fields) return null;
      type = new infer.Obj(true);
      for (var i = 0; i < fields.types.length; ++i) {
        var field = type.ensureProp(fields.labels[i]);
        field.flags |= infer.flag_initializer;
        fields.types[i].propagate(field);
      }
      pos = fields.end;
    } else {
      var start = pos;
      while (/[\w$]/.test(str.charAt(pos))) ++pos;
      if (start == pos) return null;
      var word = str.slice(start, pos);
      if (/^(number|integer)$/i.test(word)) type = infer.cx().num;
      else if (/^bool(ean)?$/i.test(word)) type = infer.cx().bool;
      else if (/^string$/i.test(word)) type = infer.cx().str;
      else {
        var found = scope.findVar(word);
        if (found) found = found.getType();
        if (!found) {
          type = ANull;
        } else if (found instanceof infer.Fn && /^[A-Z]/.test(word)) {
          var proto = found.getProp("prototype").getType();
          if (proto instanceof infer.Obj) type = infer.getInstance(proto);
        } else {
          type = found;
        }
      }
    }
    return {type: type, end: pos};
  }

  function parseTypeOuter(scope, str, pos) {
    pos = skipSpace(str, pos || 0);
    if (str.charAt(pos) != "{") return null;
    var result = parseType(scope, str, pos + 1);
    if (!result || str.charAt(result.end) != "}") return null;
    ++result.end;
    return result;
  }

  exports.applyType = function(annotation, ast, scope, walk) {
    function isDecl(_type, node) { return /^(Variable|Function)Declaration/.test(node.type); }
    var found = walk.findNodeAfter(ast, annotation.at, isDecl, infer.searchVisitor, scope);
    if (!found) return;
    scope = found.state;
    var node = found.node;

    var type, args, ret, decls = annotation.decls;
    for (var i = 0; i < decls.length; i += 2) {
      var parsed = parseTypeOuter(scope, decls[i + 1]);
      if (!parsed) continue;
      switch (decls[i]) {
      case "returns": ret = parsed.type; break;
      case "type": type = parsed.type; break;
      case "param":
        var name = decls[i + 1].slice(parsed.end).match(/^\s*([\w$]+)/);
        if (!name) continue;
        (args || (args = {}))[name[1]] = parsed.type;
        break;
      }
    }

    var varName, fn;
    if (node.type == "VariableDeclaration" && node.declarations.length == 1) {
      var decl = node.declarations[0];
      varName = decl.id.name;
      if (decl.init && decl.init.type == "FunctionExpression") fn = decl.init.body.scope.fnType;
    } else if (node.type == "FunctionDeclaration") {
      varName = node.id.name;
      fn = node.body.scope.fnType;
    } else {
      return;
    }

    if (fn && (args || ret)) {
      if (args) for (var i = 0; i < fn.argNames.length; ++i) {
        var name = fn.argNames[i], known = args[name];
        if (known) known.propagate(fn.args[i]);
      }
      if (ret) ret.propagate(fn.retval);
    } else if (type) {
      type.propagate(scope.findVar(varName));
    }
  };

})(typeof exports == "undefined" ? window.tern : exports);
