# vendor/openmontage_adapter

**Licença desta pasta: AGPL-3.0 (`AGPL-3.0-only`).** O texto está em [`LICENSE`](LICENSE).

O `fetch_footage.py` é código da Máquina de Shorts, mas ele **importa** código do
[OpenMontage](https://github.com/calesthio/OpenMontage), que é AGPL-3.0, e por isso o arquivo é tratado
como AGPL-3.0.

- **O OpenMontage não está neste repositório.** Ele é baixado à parte, num commit fixo, pelo
  `scripts/setup_vendor.ps1` (veja o README principal) e fica em `vendor/openmontage/`, que está no
  `.gitignore`.
- **O resto do projeto só chama este programa como um processo separado** (subprocesso, entrada e saída em
  JSON). Nenhum arquivo de `src/` ou de `python/` importa este arquivo, e isso não pode mudar.
- A licença dupla `MIT OR Apache-2.0` do restante do repositório **não vale para esta pasta**.
- Se você distribuir este arquivo (ou um programa que o inclua), cumpra a AGPL-3.0: ofereça o código-fonte
  correspondente a quem usar o programa, inclusive pela rede.

Este texto não é aconselhamento jurídico e ainda não foi revisado por um advogado.
