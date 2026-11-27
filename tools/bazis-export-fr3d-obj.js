/**
 * Скрипт Базис-Мебельщик: пакетный экспорт .fr3d → .obj (полигональная сетка).
 * Запуск: Базис → Скрипты → выполнить этот файл.
 * После экспорта в Keystone: «Мои фрагменты» → «Добавить сетку…» к карточке,
 * либо при импорте .fr3d выберите рядом лежащий .obj с тем же именем.
 */
(function () {
  var fs = null;
  try { fs = require('fs'); } catch (e) {}
  if (!fs) {
    alert('Нет доступа к fs — экспортируйте вручную: Файл → Экспорт → OBJ');
    return;
  }

  var srcDir = '';
  var outDir = '';
  try { srcDir = system.askFolder('Папка с .fr3d'); } catch (e) { alert('askFolder: ' + e); return; }
  if (!srcDir) return;
  try { outDir = system.askFolder('Папка для .obj (можно ту же)'); } catch (e) { alert('askFolder out: ' + e); return; }
  if (!outDir) outDir = srcDir;

  function listFr3d(dir) {
    var names = [];
    try {
      var entries = fs.readdirSync(dir);
      for (var i = 0; i < entries.length; i++) {
        var n = String(entries[i]);
        if (/\.fr3d$/i.test(n)) names.push(n);
      }
    } catch (e) {
      alert('readdir: ' + e);
    }
    return names;
  }

  function join(a, b) {
    if (!a) return b;
    var sep = a.indexOf('\\') >= 0 ? '\\' : '/';
    if (a.charAt(a.length - 1) === sep) return a + b;
    return a + sep + b;
  }

  var files = listFr3d(srcDir);
  if (!files.length) {
    alert('В папке нет .fr3d');
    return;
  }

  var ok = 0;
  var fail = [];
  for (var i = 0; i < files.length; i++) {
    var name = files[i];
    var src = join(srcDir, name);
    var stem = name.replace(/\.fr3d$/i, '');
    var dst = join(outDir, stem + '.obj');
    try {
      if (typeof modelIOOperations !== 'undefined' && modelIOOperations.LoadModelFromFile) {
        modelIOOperations.LoadModelFromFile(src);
        var model = (typeof currentFileData !== 'undefined') ? currentFileData.model : null;
        if (model && modelIOOperations.ExportModelMeshFormat) {
          modelIOOperations.ExportModelMeshFormat(model, dst, '');
          ok++;
          continue;
        }
      }
    } catch (e1) { /* fallback */ }

    try {
      var furn = OpenFurniture(src);
      if (furn && typeof modelIOOperations !== 'undefined' && modelIOOperations.ExportModelMeshFormat) {
        var m = furn.Model || furn;
        modelIOOperations.ExportModelMeshFormat(m, dst, '');
        ok++;
        continue;
      }
    } catch (e2) {
      fail.push(name + ': ' + e2);
      continue;
    }
    fail.push(name + ': нет ExportModelMeshFormat');
  }

  var msg = 'Экспортировано: ' + ok + ' из ' + files.length;
  if (fail.length) msg += '\nОшибки:\n' + fail.slice(0, 8).join('\n');
  alert(msg);
})();
