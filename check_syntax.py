#!/usr/bin/env python3
"""Проверка синтаксиса JavaScript файла"""

import sys

def check_braces_balance(code):
    """Проверяет баланс скобок"""
    stack = []
    pairs = {')': '(', ']': '[', '}': '{'}
    
    for i, char in enumerate(code):
        if char in '([{':
            stack.append((char, i))
        elif char in ')]}':
            if not stack:
                return False, f"Непарная закрывающая скобка '{char}' на позиции {i}"
            top, pos = stack.pop()
            if top != pairs[char]:
                return False, f"Несоответствие скобок: '{top}' на {pos} и '{char}' на {i}"
    
    if stack:
        char, pos = stack[-1]
        return False, f"Незакрытая скобка '{char}' на позиции {pos}"
    
    return True, "Баланс скобок OK"

def check_quotes(code):
    """Проверяет баланс кавычек (упрощенно)"""
    in_string = False
    string_char = None
    escape_next = False
    
    for i, char in enumerate(code):
        if escape_next:
            escape_next = False
            continue
        
        if char == '\\':
            escape_next = True
            continue
        
        if not in_string and char in '"\'`':
            in_string = True
            string_char = char
        elif in_string and char == string_char:
            in_string = False
            string_char = None
    
    if in_string:
        return False, f"Незакрытая строка с кавычкой '{string_char}'"
    
    return True, "Кавычки OK"

def main():
    filename = 'd:\\AI\\Project_OOZ\\KS3D-clone\\Keystone-3D\\js\\planEditor.js'
    
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            code = f.read()
    except Exception as e:
        print(f"Ошибка чтения файла: {e}")
        return 1
    
    print(f"Размер файла: {len(code)} символов")
    print(f"Количество строк: {code.count(chr(10)) + 1}")
    print()
    
    # Проверка баланса скобок
    ok, msg = check_braces_balance(code)
    print(f"Скобки: {msg}")
    if not ok:
        return 1
    
    # Проверка кавычек
    ok, msg = check_quotes(code)
    print(f"Кавычки: {msg}")
    if not ok:
        return 1
    
    print()
    print("✓ Базовые проверки синтаксиса пройдены")
    return 0

if __name__ == '__main__':
    sys.exit(main())
