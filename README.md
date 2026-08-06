# FBL WebP Migrator 0.2.1

Целевая среда: Foundry VTT 13.351. Модуль не зависит от игровой системы и может работать не только с Forbidden Lands.

Модуль разделяет задачу на две части:

1. Foundry сканирует документы, экспортирует manifest и затем меняет подтвержденные ссылки `.png` на `.webp`.
2. Внешний Node-скрипт запускает официальный `cwebp`, создает WEBP рядом с PNG, проверяет результат и удаляет PNG только после успешной миграции Foundry.

## Установка

Распаковать папку `fbl-webp-migrator` в:

```text
FoundryVTT/Data/modules/fbl-webp-migrator
```

Включить модуль в мире. Открыть через Settings или макрос:

```js
game.fblWebpMigrator.open();
```

Окно и API доступны только GM.

## cwebp

Скачать официальный Windows archive libwebp:

```text
https://developers.google.com/speed/webp/docs/precompiled
```

Нужен полный путь к файлу:

```text
D:\libwebp-1.6.0-windows-x64\bin\cwebp.exe
```

Путь к одной папке `bin` не подходит.

## Полный порядок работы

### 1. Backup

Сделать копию `UserData/Data` или как минимум всех каталогов с изображениями и мира.

### 2. Сканирование

Отметить нужные области и нажать `Сканировать`.

По умолчанию включены:

- Actors и embedded documents;
- Items;
- Scenes и все стандартные embedded documents;
- Journals;
- Roll Tables;
- Cards;
- Macros;
- поиск PNG внутри HTML, Markdown, macro command, flags и system data.

Опционально включаются Users, Chat Messages, Playlists/Combats/Folders и compendiums.

### 3. Экспорт manifest

Нажать `Экспорт manifest`.

Manifest содержит случайный `manifestId`. Conversion report от другого сканирования или другого мира будет отклонен.

### 4. Конвертация

Пример Windows-команды:

```bat
node tools\convert-cwebp.js ^
  --manifest "D:\WebP\air-islands-webp-manifest.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --cwebp "D:\libwebp-1.6.0-windows-x64\bin\cwebp.exe" ^
  --quality 85
```

Lossless:

```bat
node tools\convert-cwebp.js ^
  --manifest "D:\WebP\manifest.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --cwebp "D:\libwebp-1.6.0-windows-x64\bin\cwebp.exe" ^
  --lossless
```

Перезаписать существующие WEBP:

```text
--overwrite
```

Скрипт:

- поддерживает обычные пути и wildcard `*`/`?`;
- создает временный WEBP;
- проверяет RIFF/WEBP header;
- только после проверки заменяет целевой файл;
- сохраняет существующий WEBP через временный backup при `--overwrite`;
- пропускает APNG, чтобы не уничтожать анимацию;
- возвращает exit code `2`, если были failed/skipped entries.

### 5. Импорт conversion report

Импортировать созданный `conversion-report-....json` в открытое окно модуля.

Foundry принимает от внешнего отчета только статусы и размеры. UUID, поля документов и новые пути всегда берутся из текущего manifest. Это защищает от случайно импортированного, устаревшего или измененного отчета.

Кнопка `WEBP уже готовы` предназначена для уже выполненной вручную конвертации. Она не проверяет диск и требует подтверждения.

### 6. Применение путей

Нажать `Применить пути`.

Перед записью модуль проверяет, что поле все еще содержит старое значение из manifest. Если поле изменилось после сканирования, оно получает статус `stale` и не перезаписывается.

После `Document.update` итоговое значение проверяется повторно.

Заблокированные world compendiums могут временно открываться и затем снова блокироваться. Запись в system/module compendiums выключена по умолчанию.

### 7. Экспорт migration report

Экспортировать migration report. Только записи из массива `migrated` разрешены для cleanup.

### 8. Dry-run cleanup

```bat
node tools\convert-cwebp.js ^
  --cleanup "D:\WebP\migration-report.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data"
```

### 9. Удаление PNG

```bat
node tools\convert-cwebp.js ^
  --cleanup "D:\WebP\migration-report.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --delete
```

Cleanup откажется удалять PNG, если соответствующий WEBP отсутствует или не имеет RIFF/WEBP header.

## Откат

Кнопка `Откатить пути` возвращает только ссылки, измененные текущим запуском приложения. Файлы на диске она не меняет.

Откат нужно выполнять до удаления PNG либо после восстановления PNG из backup.

## Публичный API

Открыть приложение:

```js
game.fblWebpMigrator.open();
```

Сканирование без DOM приложения:

```js
const manifest = await game.fblWebpMigrator.scanToManifest({
  worldActors: true,
  worldScenes: true,
  worldCompendiums: false
});
```

## Что покрывает 0.2.1

Сканер читает source data выбранных Foundry Documents рекурсивно. Стандартные embedded documents обходятся отдельно, чтобы их можно было обновлять через собственные UUID.

Покрываются:

- `Actor`, prototype token, Items и Active Effects;
- world `Item` и Active Effects;
- `Scene` и persisted fields, включая background/foreground;
- Tokens, Tiles, Drawings, Notes, Measured Templates, Regions и другие стандартные embedded scene documents;
- `JournalEntry` и `JournalEntryPage`;
- `RollTable` и `TableResult`;
- `Cards` и `Card`;
- `Macro` icon и command;
- `User` при включенной опции;
- Chat Messages при включенной опции;
- Playlists, Combats и Folders при включенной опции;
- `flags` и `system` data всех просканированных документов;
- локальные PNG внутри HTML/Markdown/CSS-подобных строк;
- world compendiums поддерживаемых типов;
- system/module compendiums в режиме явного opt-in;
- query/hash suffixes;
- wildcard token paths.

## Что модуль не покрывает

- world/client settings и значения в `game.settings`;
- Adventure compendiums и сериализованные документы внутри Adventure;
- PNG-файлы, которые вообще нигде не указаны в просканированных Foundry Documents;
- пути в физических `.js`, `.mjs`, `.css`, `.hbs`, `.json` и других файлах модулей, систем и миров;
- remote HTTP/HTTPS, `data:`, `blob:`, `file:` и S3-подобные источники;
- browser localStorage, client caches и runtime-only texture caches;
- вычисляемые или собираемые в коде пути, например `"art/" + name + ".png"`;
- сложные escaped HTML/CSS конструкции, которые не распознает эвристический строковый scanner;
- APNG. Они намеренно пропускаются;
- package compendium updates, если не включена опасная опция записи;
- поля документов и типы compendium, которые появятся в стороннем модуле вне стандартной Document hierarchy и хранят данные не в source data.

Это означает, что migration report гарантирует отсутствие старых ссылок только внутри выбранных областей сканирования. Он не является доказательством, что в `Data` больше нет ни одного PNG-файла или текстовой ссылки.

## Проверки

```bash
npm run check
```

Проверяются чистые функции поиска путей, защита от prototype pollution, обход embedded documents, привязка conversion report к manifest, stale-field guard, миграция и откат.
