import json
from pathlib import Path
import subprocess
import tempfile


root = Path(__file__).resolve().parents[2]
source = (root / 'internal/src/core/ipc/IpcMessages.cpp').read_text()
start = source.index('int BuildNavStatus(')
end = source.index('\nint BuildHello(', start)
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    program = directory / 'nav_status.cpp'
    program.write_text('#include <cstdint>\n#include <cstdio>\n#include <cstring>\n#include <cassert>\n'
                       + source[start:end] + r'''
int main() {
    char buffer[384];
    assert(BuildNavStatus(buffer, sizeof(buffer), "point", 12, 3, "unreachable", "map_changed") > 0);
    puts(buffer);
    assert(BuildNavStatus(buffer, sizeof(buffer), "ring", 42, 3, "partial", "frontier") > 0);
    puts(buffer);
    assert(BuildNavStatus(buffer, sizeof(buffer), "point", 0, 3, "routing", "") == -1);
    assert(BuildNavStatus(buffer, sizeof(buffer), "point", 12, 3, "invalid", "") == -1);
    assert(BuildNavStatus(buffer, sizeof(buffer), "point", 12, 3, "routing", "bad\"json") == -1);
    assert(BuildNavStatus(buffer, 4, "point", 12, 3, "routing", "") == -1);
    assert(BuildNavStatus(buffer, sizeof(buffer), "point", 9007199254740992ULL, 3, "routing", "") == -1);
}
''')
    executable = directory / 'nav_status'
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', str(program), '-o', str(executable)], check=True)
    result = subprocess.run([str(executable)], check=True, text=True, capture_output=True)
    point, ring = [json.loads(line) for line in result.stdout.splitlines()]
    assert point == dict(type='navStatus', goalKind='point', goalId=12, generation=3, state='unreachable', reason='map_changed')
    assert ring == dict(type='navStatus', goalKind='ring', goalId=42, generation=3, state='partial', reason='frontier')
print('navStatus production encoder: 9 assertions passed')
