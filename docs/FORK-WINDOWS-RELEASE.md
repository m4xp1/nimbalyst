# Выпуск Windows x64 в форке

`main` содержит обновления upstream. `features` содержит дополнения форка.
`release` объединяет выбранную версию upstream, дополнения и workflow Windows x64.
Исходный checkout `Nimbalyst` остаётся на `features`; подготовка выпуска идёт в worktree `Nimbalyst-release`.

Workflow `.github/workflows/electron-build.yml` собирает только Windows x64.
Ручной запуск на `release` проверяет и собирает артефакт без публикации.
Push тега `v<версия packages/electron/package.json>` на коммите, принадлежащем `release`,
запускает те же проверки и публикует GitHub Release в `m4xp1/nimbalyst`.
GitHub не умеет одновременно ограничивать tag push именем ветки: принадлежность коммита проверяется через `git merge-base --is-ancestor`.

Проверки: typecheck всех workspace, существующие тесты дополнений и регрессионный тест feed updater,
загрузка SQLite/node-pty в закреплённом Electron, штатные build:win и валидаторы упаковки.
Это не полный прогон всех unit-тестов и не интерактивная проверка установленного приложения.

Артефакты: `Nimbalyst-Windows-x64.exe` и `SHA256SUMS.txt`.
Сборка неподписанная: штатный явный флаг `ALLOW_UNSIGNED_WINDOWS_BUILD=true`;
секреты DigiCert и сертификат официального Nimbalyst не используются.
Упаковка публикует assets в `m4xp1/nimbalyst`, а runtime updater проверяет оригинальный
`nimbalyst/nimbalyst` и сообщает о новых официальных версиях. Скачивание автоматически
не начинается (`autoDownload=false`), установка при выходе отключена (`autoInstallOnAppQuit=false`).
Уведомление позволяет посмотреть release notes или отложить напоминание; ручные кнопки
скачивания/установки оригинального билда остаются. Для сохранения дополнений новую версию
форка нужно собрать и установить вручную. `latest.yml` форка не публикуется.

Перед тегом:

```powershell
git switch main
git merge --ff-only <upstream-release-commit>
git switch release
git merge main
git merge features
git push origin main release
# Проверить ручную сборку release, затем:
git tag -a v0.79.1+m4xp1.1 -m "Nimbalyst 0.79.1+m4xp1.1 fork: Windows x64"
git push origin refs/tags/v0.79.1+m4xp1.1
```

При ошибке workflow сохранить лог, исправить причину и повторить проверку.
Уже опубликованный тег не перемещать без отдельного решения владельца.

## Форк 0.79.1+m4xp1.1

Предыдущий опубликованный v0.79.1 сохраняется. Версия приложения и About: 0.79.1+m4xp1.1; числовая FileVersion Windows: 0.79.1.1. Метаданные SemVer не повышают базовую версию upstream. CI проверяет FileVersion упакованного приложения, версию package.json внутри app.asar и записывает метаданные установщика.

Описание изменений: [FORK-v0.79.1-m4xp1.1](FORK-v0.79.1-m4xp1.1.md).
Инструкция для агента после ручной установки: [FORK-SEARCH-ACCEPTANCE-v0.79.1-m4xp1.1](FORK-SEARCH-ACCEPTANCE-v0.79.1-m4xp1.1.md).

В workflow добавлены тесты меню пути, общего состояния редактора, сохранения, Unicode-миграции, источников и статусов Memory. Платные API в автоматических тестах не вызываются. Успешная сборка не заменяет приёмку установленного интерфейса и поиска через настроенный OpenAI.
