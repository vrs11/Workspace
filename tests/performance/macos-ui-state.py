"""Read-only labels for the ordinary fixture; source values are never read."""
import json
import sys
from macos_fixture_ui import FixtureUi

ui = FixtureUi(int(sys.argv[1]))
print(json.dumps({"pid": ui.pid, "identifier": "org.agentworkspace.performance", "labels": ui.describe()}))
