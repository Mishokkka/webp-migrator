# FBL WebP Migrator 0.4.7

Целевая среда: Foundry VTT 13.351. Модуль не зависит от игровой системы.

Модуль решает две разные задачи:

1. Проверяет уже существующее состояние мира и исправляет рассинхронизацию между путями Foundry и файлами PNG/WEBP на диске.
2. Выполняет управляемую конвертацию PNG в WEBP, меняет подтвержденные пути и отправляет только проверенные PNG в карантин.

Проверка диска выполняется внешним Node.js-инструментом. Сам Foundry не имеет безопасного прямого доступа ко всему каталогу `Data`.

## Требования

- Foundry VTT 13.351;
- Node.js 20 или новее для `tools/convert-cwebp.js` и тестов;
- официальный `cwebp` из libwebp для новой конвертации;
- резервная копия Foundry `Data` и мира перед изменениями.

Официальные сборки libwebp:

```text
https://developers.google.com/speed/webp/docs/precompiled
```

Указывайте путь к исполняемому файлу, а не к папке `bin`:

```text
D:\libwebp\bin\cwebp.exe
```

## Установка

Распакуйте папку `fbl-webp-migrator` в:

```text
FoundryVTT/Data/modules/fbl-webp-migrator
```

Включите модуль в нужном мире. Окно доступно GM через настройки модулей или консоль:

```js
game.fblWebpMigrator.open();
```

# Исправление уже возникшей рассинхронизации

Этот режим предназначен для случаев, когда:

- Foundry уже ссылается на `.webp`, но WEBP отсутствует или поврежден, а PNG сохранился;
- Foundry все еще ссылается на `.png`, хотя корректный WEBP уже существует;
- часть прежней миграции была применена только к диску или только к документам Foundry.

## 1. Создайте резервную копию

Сохраните копию `Data` и мира. Не редактируйте проверяемые документы между сканированием, аудитом и применением исправлений.

## 2. Выполните новое сканирование

Версия 0.4.0 сканирует и PNG-, и WEBP-ссылки. Для проверки согласованности нужен manifest, созданный версией 0.4.0 или новее. Старый manifest 0.3.x намеренно отклоняется, поскольку в нем нет полного списка WEBP-ссылок.

Включите все области, в которых могут находиться изображения. По умолчанию сканируются Actors, Items, Scenes, Journals, Roll Tables, Cards и Macros. Отдельно включаются Users, загруженные Chat Messages, дополнительные world documents, world compendiums и package compendiums.

Chat Messages охватывает только сообщения, уже загруженные текущей сессией Foundry.

## 3. Экспортируйте manifest

Кнопка создает:

```text
<world-id>-webp-manifest.json
```

Manifest содержит точные UUID, пути полей, текущие PNG-ссылки, текущие WEBP-ссылки, `manifestId` и `worldId`.

## 4. Проверьте файлы на диске

```bat
node tools\convert-cwebp.js ^
  --audit "D:\WebP\air-islands-webp-manifest.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands"
```

Режим `--audit` ничего не конвертирует, не перемещает и не удаляет. Он:

- проверяет принадлежность указанному миру и каталогу `Data`;
- защищается от выхода через symlink или junction;
- находит обе стороны каждой пары `.png` / `.webp`;
- структурно проверяет PNG, APNG и WEBP;
- читает размеры изображений;
- записывает SHA-256, размер и время изменения каждого найденного файла;
- отдельно оценивает каждый конкретный файл wildcard-пути.

По умолчанию отчет создается рядом с manifest:

```text
consistency-report-<timestamp>.json
```

## 5. Импортируйте consistency report

В окне модуля выберите `Импорт consistency-report.json`.

Если audit обнаружил путь, для которого **нет ни PNG, ни WEBP**, он помечается как `repair-to-placeholder`. В таком случае отдельная кнопка **«Заменить отсутствующие на заглушку»** заменит найденные ссылки Foundry на `icons/svg/mystery-man.svg`. Это отдельная операция, wildcard-пути не затрагиваются, а все изменения записываются в migration report и могут быть откатаны.

Foundry не доверяет готовым флагам отчета. Разрешение на исправление пересчитывается из проверенных файлов и текущего manifest.

### Автоматически исправляемые случаи

`PNG -> WEBP` разрешается, когда Foundry ссылается на PNG и:

- корректный WEBP существует;
- PNG отсутствует или поврежден; либо
- оба файла корректны, PNG не является APNG, а размеры PNG и WEBP совпадают.

`WEBP -> PNG` разрешается, когда Foundry ссылается на WEBP и:

- WEBP отсутствует или поврежден;
- корректный PNG существует.

### Случаи, которые остаются без изменений

- отсутствуют оба файла;
- оба файла повреждены;
- PNG является APNG;
- размеры двух корректных файлов не совпадают;
- wildcard-пара содержит хотя бы один небезопасный конкретный файл;
- документ или поле изменились после сканирования;
- область не была включена в manifest;
- документ или compendium нельзя безопасно записать.

## 6. Нажмите «Исправить безопасные случаи»

Перед каждой записью модуль повторно читает документ. Изменившееся значение получает статус `stale` и не перезаписывается.

Записываются только конкретные leaf-поля. Соседние изменения в `system`, `flags` и других объектах не затираются. После `Document.update` результат проверяется повторно.

Исправление согласованности не дает права на cleanup. Оно меняет только ссылки Foundry. Файлы на диске остаются на месте.

## 7. Проверьте результат повторным аудитом

После исправления создайте новый manifest и снова выполните `--audit`. Это покажет оставшиеся неоднозначные или недоступные случаи.

## 8. Сохраните migration report

Экспортируйте migration report сразу после исправления. Он хранит изменения обоих направлений:

- PNG -> WEBP;
- WEBP -> PNG.

Кнопка `Откатить пути` возвращает каждое поле в состояние до соответствующего изменения. Файлы на диске при откате не меняются.

Если последовательные изменения одного поля взаимно отменили друг друга, объединенный отчет не пытается откатывать их повторно. Если путь был возвращен на PNG, прежнее разрешение удалить этот PNG исключается из объединенного cleanup-списка.

# Новая конвертация PNG в WEBP

## 1. Сканирование и manifest

Выполните сканирование и экспортируйте manifest так же, как описано выше.

## 2. Предварительная проверка конвертации

```bat
node tools\convert-cwebp.js ^
  --manifest "D:\WebP\air-islands-webp-manifest.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands" ^
  --cwebp "D:\libwebp\bin\cwebp.exe" ^
  --quality 85 ^
  --dry-run

Если dry-run показывает `failed`, это не обязательно означает отсутствие файла. В 0.4.2 conversion report и UI показывают конкретную причину: неверный `--data` root, отсутствующий файл, не-PNG содержимое под `.png`-именем, поврежденный/устаревший существующий WEBP и т.д. Путь из manifest всегда разрешается как `<--data>/<путь из Foundry>`.
```

## 3. Конвертация

```bat
node tools\convert-cwebp.js ^
  --manifest "D:\WebP\air-islands-webp-manifest.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands" ^
  --cwebp "D:\libwebp\bin\cwebp.exe" ^
  --quality 85
```

Полезные параметры:

```text
--lossless          lossless WEBP
--overwrite         заменить существующий WEBP после проверки нового файла
--trust-existing    разрешить существующий WEBP, который старше PNG
--allow-larger      принять WEBP, который больше исходного PNG
--out <file>        задать имя отчета
```

По умолчанию WEBP, который больше PNG, получает статус `larger` и не разрешает миграцию. APNG всегда пропускается, даже если рядом уже существует WEBP.

Конвертер проверяет:

- строгий синтаксис параметров;
- `worldId` и Data-root fingerprint;
- выход за пределы `Data`, symlink и junction;
- структуру PNG, APNG и WEBP;
- совпадение размеров изображения;
- SHA-256, размер и время изменения файлов;
- атомарную замену при `--overwrite`;
- wildcard `*` и `?`.

## 4. Импорт conversion report и применение путей

Foundry принимает только отчет для текущих `manifestId` и `worldId`. UUID, поля и разрешенные пары путей всегда берутся из manifest. Сводка и файловые метаданные пересчитываются.

Кнопка `WEBP уже готовы` создает только внутреннее непроверенное предположение. Оно может менять пути после ручной проверки, но никогда не дает права на cleanup.

Перед каждым изменением применяется stale guard. World compendiums при необходимости временно разблокируются. Намерение вернуть блокировку сохраняется в world setting. После аварийного закрытия Foundry модуль пытается восстановить замки при следующем запуске.

Embedded documents обновляются через API их родителя. Для `ActorDelta` внутри Token используется запись `Token.delta` через Scene, а после записи Compendium Scene перечитывается из pack перед верификацией. Это важно для старых сцен и несвязанных токенов, где прямой `ActorDelta.update()` в Foundry v13 может быть ненадежным.

System/module compendiums изменяются только при явном включении опасной опции и только если pack уже разблокирован.

## 5. Экспорт migration report

Кнопка создает:

```text
<world-id>-webp-migration-report.json
```

Отчет содержит историю отката и конкретный список `cleanupFiles`. Cleanup разрешается только для файлов, подтвержденных conversion report и успешным применением всех ссылок соответствующего manifest-пути.

# Cleanup и карантин

## Dry-run

```bat
node tools\convert-cwebp.js ^
  --cleanup "D:\WebP\air-islands-webp-migration-report.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands"
```

Cleanup не разворачивает wildcard повторно. Используются только конкретные файлы из migration report. Перед действием заново проверяются Data root, world ID, пути, SHA-256, размеры файлов и размеры изображений.

## Перемещение PNG в карантин

```bat
node tools\convert-cwebp.js ^
  --cleanup "D:\WebP\air-islands-webp-migration-report.json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands" ^
  --delete
```

Один `--delete` не уничтожает PNG. Файлы перемещаются в:

```text
Data/.fbl-webp-migrator-quarantine/<timestamp>/...
```

## Восстановление из карантина

```bat
node tools\convert-cwebp.js ^
  --restore "D:\WebP\cleanup-report-....json" ^
  --data "C:\Users\USER\AppData\Local\FoundryVTT\Data" ^
  --world-id "air-islands"
```

Существующий файл не перезаписывается. Хеш карантинного PNG должен совпасть с отчетом.

Безвозвратное удаление требует двух флагов:

```text
--delete --permanent-delete
```

Значения вида `--delete false` отклоняются как ошибка синтаксиса.

# Публичный API

API доступен двумя способами:

```js
game.fblWebpMigrator
game.modules.get("fbl-webp-migrator").api
```

Основные методы:

```js
const manifest = await game.fblWebpMigrator.scanToManifest(options, hooks);
const migration = await game.fblWebpMigrator.applyManifestReport(manifest, conversionReport, options, hooks);
const repaired = await game.fblWebpMigrator.auditRepair(manifest, consistencyReport, options, hooks);
const placeholders = await game.fblWebpMigrator.repairMissingAssets(manifest, consistencyReport, options, hooks);
const rollback = await game.fblWebpMigrator.rollbackReport(migrationReport, options, hooks);
```

`hooks` может содержать `{ signal, onProgress }`.

# Что покрывается

- Actor, prototype token, embedded Items и Active Effects;
- world Item и Active Effects;
- Scene и стандартные embedded documents;
- JournalEntry и JournalEntryPage;
- RollTable и TableResult;
- Cards и Card;
- Macro icon и command;
- User при включенной опции;
- загруженные Chat Messages при включенной опции;
- Playlists, Combats и Folders при включенной опции;
- flags и system data просканированных документов;
- локальные PNG- и WEBP-ссылки внутри HTML, Markdown и CSS-подобных строк;
- bare filenames в известных asset-полях и массивах;
- world compendiums поддерживаемых типов;
- system/module compendiums в явном opt-in режиме;
- query/hash suffixes, wildcard paths и пути с внешними пробелами.

# Ограничения

- world/client settings и значения в `game.settings` не сканируются;
- Adventure compendiums и сериализованные документы внутри Adventure не сканируются;
- физические `.js`, `.mjs`, `.css`, `.hbs`, `.json` файлов модулей и систем не сканируются;
- remote HTTP/HTTPS, `data:`, `blob:`, `file:`, S3, UNC, absolute и drive-relative пути отклоняются;
- вычисляемые кодом пути не распознаются;
- эвристический rich-text scanner не гарантирует покрытие любой нестандартной escaped-разметки;
- APNG намеренно не конвертируется и не заменяется на существующий WEBP автоматически;
- Chat Messages ограничены уже загруженной историей;
- module/system updates могут затереть изменения package compendiums;
- аудит доказывает состояние только путей и областей, включенных в конкретный manifest.

# Тесты

```bash
npm run check
```

Набор включает тесты PNG/WEBP scanner, manifest/report sanitization, двусторонний consistency repair, stale guard, leaf updates, двусторонний rollback, объединение отчетов, compendium lock recovery, CLI parsing, APNG, структурную валидацию изображений, wildcard, symlink escape, atomic overwrite, hash-bound cleanup, quarantine и restore.

Исторический сводный разбор исправлений 0.3.0 находится в `REVIEW_RESOLUTION_0.3.0.md`.

## Image Hover 3.1

Image Hover использует `flags.image-hover.specificArt = "path/image.png"` как специальное нейтральное значение: при нем модуль показывает обычный Actor/Token art. Это не реальный файл.

Кнопка **«Исправить Image Hover»** в 0.4.5 выполняет полный recovery-проход по всем world Actors, world Scenes (Token и ActorDelta) и world Actor/Scene compendiums независимо от обычных галочек сканирования. FBL WebP Migrator 0.4.5 игнорирует этот sentinel при сканировании.

Для отсутствующего реального `Specific image on hover` placeholder-repair теперь возвращает поле к `path/image.png`, а не к `icons/svg/mystery-man.svg`. Отдельная кнопка **«Исправить Image Hover»** исправляет ошибочные `mystery-man.svg` overrides, созданные placeholder-repair в 0.4.2/0.4.3. Она затрагивает только поля `flags.image-hover.specificArt`, которые сейчас точно равны `icons/svg/mystery-man.svg`. World Actor/Scene compendiums проверяются автоматически. System/module compendiums проверяются только когда одновременно включены их сканирование и опасное разрешение записи в package packs.


## Foundry Core Data

Пути из встроенного публичного хранилища Foundry не находятся в `UserData/Data` и не должны участвовать в PNG/WEBP migration. В v13 к Core Data относятся верхнеуровневые каталоги `cards/`, `css/`, `fonts/`, `icons/`, `lang/`, `scripts/`, `sounds/` и `ui/`. Модуль 0.4.7 исключает такие ссылки при новом сканировании, при импорте старого manifest и дополнительно во внешнем CLI.

Если версия 0.4.2–0.4.6 уже заменила реальный Core Data путь на placeholder, импортируйте migration report того прогона. Кнопка **«Восстановить Core Data»** откатывает только placeholder-изменения, чей исходный путь относился к Core Data; остальные изменения отчета не трогаются. Без migration report или резервной копии исходный путь после замены на placeholder достоверно восстановить нельзя.
