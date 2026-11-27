// Страница «Модуль v3». Кнопка в шапке сцены только открывает module3.html.
// Логику конструктора модулей добавляет другой разработчик в этой ветке.
import { gatePage } from '../authGate.js?v=20261127g';

const root = document.getElementById('v3root');
if (root) {
  root.innerHTML = '<p class="muted" style="padding:16px">Конструктор модулей v3 — в разработке.</p>';
}

(async () => {
  try {
    await gatePage();
  } catch (e) {
    console.error(e);
  }
})();
