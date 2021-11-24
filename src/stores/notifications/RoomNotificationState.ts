/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { NotificationColor } from "./NotificationColor";
import { IDestroyable } from "../../utils/IDestroyable";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { EffectiveMembership, getEffectiveMembership } from "../../utils/membership";
import { readReceiptChangeIsFor } from "../../utils/read-receipts";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";
import { Room, RoomEvents } from "matrix-js-sdk/src/models/room";
import { NotificationCountType } from "matrix-js-sdk/src/@types/receipt";
import * as RoomNotifs from '../../RoomNotifs';
import * as Unread from '../../Unread';
import { NotificationState } from "./NotificationState";
import { getUnsentMessages } from "../../components/structures/RoomStatusBar";
import { Thread, ThreadEvent } from "matrix-js-sdk/src/models/thread";
import SettingsStore from "../../settings/SettingsStore";
import { ReceiptEvents } from "matrix-js-sdk/src/models/receipt";

export class RoomNotificationState extends NotificationState implements IDestroyable {
    constructor(public readonly room: Room) {
        super();
        this.room.on(ReceiptEvents.Receipt, this.handleReadReceipt);
        this.room.on(RoomEvents.Timeline, this.handleRoomEventUpdate);
        this.room.on(RoomEvents.Redaction, this.handleRoomEventUpdate);
        this.room.on(RoomEvents.MyMembership, this.handleMembershipUpdate);
        this.room.on(RoomEvents.LocalEchoUpdated, this.handleLocalEchoUpdated);
        MatrixClientPeg.get().on("Event.decrypted", this.handleRoomEventUpdate);
        MatrixClientPeg.get().on("accountData", this.handleAccountDataUpdate);
        if (SettingsStore.getValue("feature_thread")) {
            this.room.on(ThreadEvent.Update, this.handleThreadUpdate);
        }
        this.updateNotificationState();
    }

    private get roomIsInvite(): boolean {
        return getEffectiveMembership(this.room.getMyMembership()) === EffectiveMembership.Invite;
    }

    public destroy(): void {
        super.destroy();
        this.room.removeListener(ReceiptEvents.Receipt, this.handleReadReceipt);
        this.room.removeListener(RoomEvents.Timeline, this.handleRoomEventUpdate);
        this.room.removeListener(RoomEvents.Redaction, this.handleRoomEventUpdate);
        this.room.removeListener(RoomEvents.MyMembership, this.handleMembershipUpdate);
        this.room.removeListener(RoomEvents.LocalEchoUpdated, this.handleLocalEchoUpdated);
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Event.decrypted", this.handleRoomEventUpdate);
            MatrixClientPeg.get().removeListener("accountData", this.handleAccountDataUpdate);
        }
        if (SettingsStore.getValue("feature_thread")) {
            this.room.removeListener(ThreadEvent.Update, this.handleThreadUpdate);
        }
    }

    private handleLocalEchoUpdated = () => {
        this.updateNotificationState();
    };

    private handleReadReceipt = (event: MatrixEvent, room: Room) => {
        if (!readReceiptChangeIsFor(event, MatrixClientPeg.get())) return; // not our own - ignore
        if (room.roomId !== this.room.roomId) return; // not for us - ignore
        this.updateNotificationState();
    };

    private handleMembershipUpdate = () => {
        this.updateNotificationState();
    };

    private handleRoomEventUpdate = (event: MatrixEvent) => {
        const roomId = event.getRoomId();

        if (roomId !== this.room.roomId) return; // ignore - not for us
        this.updateNotificationState();
    };

    private handleThreadUpdate = (thread: Thread) => {
        if (thread.roomId !== this.room.roomId) return; // ignore - not for us
        this.updateNotificationState();
    };

    private handleAccountDataUpdate = (ev: MatrixEvent) => {
        if (ev.getType() === "m.push_rules") {
            this.updateNotificationState();
        }
    };

    protected get isRoomMuted(): boolean {
        return RoomNotifs.getRoomNotifsState(this.room.roomId) === RoomNotifs.RoomNotifState.Mute;
    }

    protected setMutedState(): void {
        // When muted we suppress all notification states, even if we have context on them.
        this._color = NotificationColor.None;
        this._symbol = null;
        this._count = 0;
    }

    protected setNotificationState(redNotifs: number, greyNotifs: number): void {
        const trueCount = this.trueCount(redNotifs, greyNotifs);

        // Note: we only set the symbol if we have an actual count. We don't want to show
        // zero on badges.

        if (redNotifs > 0) {
            this._color = NotificationColor.Red;
            this._count = trueCount;
            this._symbol = null; // symbol calculated by component
        } else if (greyNotifs > 0) {
            this._color = NotificationColor.Grey;
            this._count = trueCount;
            this._symbol = null; // symbol calculated by component
        } else {
            // We don't have any notified messages, but we might have unread messages. Let's
            // find out.
            const hasUnread = Unread.doesRoomHaveUnreadMessages(this.room);
            if (hasUnread) {
                this._color = NotificationColor.Bold;
            } else {
                this._color = NotificationColor.None;
            }

            // no symbol or count for this state
            this._count = 0;
            this._symbol = null;
        }
    }

    protected updateNotificationState(): void {
        const snapshot = this.snapshot();

        if (getUnsentMessages(this.room).length > 0) {
            // When there are unsent messages we show a red `!`
            this._color = NotificationColor.Unsent;
            this._symbol = "!";
            this._count = 1; // not used, technically
        } else if (this.isRoomMuted) {
            this.setMutedState();
        } else if (this.roomIsInvite) {
            this._color = NotificationColor.Red;
            this._symbol = "!";
            this._count = 1; // not used, technically
        } else {
            const redNotifs = RoomNotifs.getUnreadNotificationCount(this.room, NotificationCountType.Highlight);
            const greyNotifs = RoomNotifs.getUnreadNotificationCount(this.room, NotificationCountType.Total);
            this.setNotificationState(redNotifs, greyNotifs);
        }

        // finally, publish an update if needed
        this.emitIfUpdated(snapshot);
    }
}
