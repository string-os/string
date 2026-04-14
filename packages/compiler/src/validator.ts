/**
 * SFMD Validator — checks a compiled .md file for spec compliance
 */

import { parse } from '@string-os/core';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  info: ValidationInfo;
}

export interface ValidationError {
  line: number;
  code: string;
  message: string;
}

export interface ValidationInfo {
  blocks: string[];
  includes: string[];
  menus: string[];
  shortcuts: string[];
}

export function validate(source: string): ValidationResult {
  const { blocks, includes, menus, shortcuts, errors: parseErrors } = parse(source);

  const errors: ValidationError[] = parseErrors.map(e => ({
    line: e.line,
    code: e.message.split(':')[0],
    message: e.message,
  }));

  // Check include identifiers are unique
  const includeIds = new Set<string>();
  for (const inc of includes) {
    if (includeIds.has(inc.id)) {
      errors.push({
        line: inc.line,
        code: 'DUPLICATE_INCLUDE_ID',
        message: `DUPLICATE_INCLUDE_ID: [!include:${inc.id}] is already declared`,
      });
    }
    includeIds.add(inc.id);
  }

  // Check menu names are unique
  const menuNames = new Set<string>();
  for (const menu of menus) {
    if (menuNames.has(menu.name)) {
      errors.push({
        line: menu.line,
        code: 'DUPLICATE_MENU_NAME',
        message: `DUPLICATE_MENU_NAME: [!menu:${menu.name}] is already declared`,
      });
    }
    menuNames.add(menu.name);
  }

  // Block IDs must not collide with include IDs
  // (both become addressable via #id on the same document)
  const allBlockIds = new Set<string>([...blocks.map(b => b.id), ...includes.map(i => i.id)]);
  if (allBlockIds.size < blocks.length + includes.length) {
    // Find the collision
    const seen = new Set<string>();
    for (const b of blocks) {
      if (seen.has(b.id)) {
        errors.push({
          line: b.startLine,
          code: 'BLOCK_ID_COLLISION',
          message: `BLOCK_ID_COLLISION: {#${b.id}} collides with an include id`,
        });
      }
      seen.add(b.id);
    }
  }

  errors.sort((a, b) => a.line - b.line);

  return {
    valid: errors.length === 0,
    errors,
    info: {
      blocks: blocks.map(b => b.id),
      includes: includes.map(i => i.id),
      menus: menus.map(m => m.name),
      shortcuts: shortcuts.map(s => `@${s.id}`),
    },
  };
}
