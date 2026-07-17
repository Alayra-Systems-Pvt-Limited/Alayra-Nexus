/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// The people of the suite. In a shared module — never exported from a spec, because
// importing a spec file re-registers its tests inside the importer.

/** The owner the API stack's first-run story creates; later API specs sign in as them. */
export const API_OWNER = {
  name: 'Abbas', email: 'abbas@e2e.alayra.com', password: 'owner-passphrase-e2e-1',
};

/** The owner the browser story creates on the UI stack. */
export const UI_OWNER = {
  name: 'Abbas', email: 'abbas@ui.alayra.com', password: 'owner-passphrase-ui-1',
};
