# Biblioteca de memes e efeitos (Onda 2)

Figurinhas, sons curtos e animações que o estágio `05b-planEdits` encaixa na narração (desligado por padrão: `editing.enabled`).

- `inventory.json` (versionado): um registro por arquivo com fonte, URL, autor, licença e tags em pt-BR.
- `files/` (ignorado pelo git): os arquivos em si. Recrie com `npm run memes -- demo` (exemplos locais) ou com os importadores.

Licenças aceitas: CC0, CC BY 4.0/3.0, CC BY-SA 4.0, Pixabay License, Lottie Simple License, Apache-2.0 e `own` (gerado aqui).
Qualquer outra é recusada pelo `npm run memes -- check` e pelo pipeline. Memes clássicos (frames de TV/filme) não entram.

```bash
npm run memes -- demo                                                    # 3 figurinhas SVG + 1 pop.wav de exemplo
npm run memes -- add-pixabay --query "boom" --kind sticker --limit 10 --tags "explosão,surpresa"
npm run memes -- add-emoji --set openmoji --codepoints 1F62E,1F4A5 --tags "surpresa,explosão"
npm run memes -- add-file --file pop.wav --kind sfx --source freesound --url https://freesound.org/s/123/ --license "CC0" --tags "pop"
npm run memes -- list
npm run memes -- check
```
