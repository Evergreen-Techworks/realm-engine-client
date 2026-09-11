// Auto-generated from data/packet-definitions.json.
// Do not edit by hand.
import type { DefsFile } from './PacketFactory.js';

const packetDefinitions: DefsFile = {
  "packets": {
    "0": {
      "name": "FAILURE",
      "direction": "server",
      "fields": [
        {
          "name": "errorId",
          "type": "int32"
        },
        {
          "name": "errorMessage",
          "type": "string"
        }
      ]
    },
    "1": {
      "name": "TELEPORT",
      "direction": "client",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "playerName",
          "type": "string"
        }
      ]
    },
    "3": {
      "name": "CLAIMDAILYLOGINREWARD",
      "direction": "client",
      "fields": [
        {
          "name": "claimStr",
          "type": "string"
        },
        {
          "name": "claimType",
          "type": "string"
        }
      ]
    },
    "4": {
      "name": "DELETEPETMESSAGE",
      "direction": "server",
      "fields": []
    },
    "5": {
      "name": "REQUESTTRADE",
      "direction": "client",
      "fields": [
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    "6": {
      "name": "QUESTFETCHRESPONSE",
      "direction": "server",
      "fields": []
    },
    "7": {
      "name": "JOINGUILD",
      "direction": "client",
      "fields": []
    },
    "8": {
      "name": "PING",
      "direction": "server",
      "fields": [
        {
          "name": "serial",
          "type": "int32"
        }
      ]
    },
    "9": {
      "name": "PLAYERTEXT",
      "direction": "client",
      "fields": [
        {
          "name": "text",
          "type": "string"
        }
      ]
    },
    "10": {
      "name": "NEWTICK",
      "direction": "server",
      "fields": [
        {
          "name": "tickId",
          "type": "int32"
        },
        {
          "name": "tickTime",
          "type": "int32"
        },
        {
          "name": "serverRealTimeMs",
          "type": "uint32"
        },
        {
          "name": "serverLastRttMs",
          "type": "uint16"
        },
        {
          "name": "statuses",
          "type": "array",
          "lengthType": "int16",
          "elementType": "Status"
        }
      ]
    },
    "11": {
      "name": "SHOWEFFECT",
      "direction": "server",
      "fields": []
    },
    "12": {
      "name": "SERVERPLAYERSHOOT",
      "direction": "server",
      "fields": [
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "ownerId",
          "type": "int32"
        },
        {
          "name": "containerType",
          "type": "int32"
        },
        {
          "name": "startingPos",
          "type": "Location"
        },
        {
          "name": "angle",
          "type": "float"
        },
        {
          "name": "damage",
          "type": "int16"
        },
        {
          "name": "superOwnerId",
          "type": "int32"
        },
        {
          "name": "bulletType",
          "type": "byte",
          "optional": true,
          "default": 255
        },
        {
          "name": "numShots",
          "type": "byte",
          "optional": true,
          "default": 0
        },
        {
          "name": "angleInc",
          "type": "float",
          "optional": true,
          "default": -1
        }
      ]
    },
    "13": {
      "name": "USEITEM",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "slotObject",
          "type": "SlotObject"
        },
        {
          "name": "itemUsePos",
          "type": "Location"
        },
        {
          "name": "useType",
          "type": "byte"
        },
        {
          "name": "unknownInt",
          "type": "int32"
        }
      ]
    },
    "14": {
      "name": "TRADEACCEPTED",
      "direction": "server",
      "fields": [
        {
          "name": "clientOffer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        },
        {
          "name": "partnerOffer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        }
      ]
    },
    "15": {
      "name": "GUILDREMOVE",
      "direction": "client",
      "fields": []
    },
    "16": {
      "name": "PETUPGRADEREQUEST",
      "direction": "client",
      "fields": []
    },
    "17": {
      "name": "ENTERARENA",
      "direction": "server",
      "fields": []
    },
    "18": {
      "name": "GOTO",
      "direction": "server",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "unknown",
          "type": "int32"
        }
      ]
    },
    "19": {
      "name": "INVDROP",
      "direction": "client",
      "fields": [
        {
          "name": "slotObject",
          "type": "SlotObject"
        },
        {
          "name": "unknownByte",
          "type": "sbyte"
        }
      ]
    },
    "20": {
      "name": "OTHERHIT",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "targetId",
          "type": "int32"
        }
      ]
    },
    "21": {
      "name": "NAMERESULT",
      "direction": "server",
      "fields": []
    },
    "22": {
      "name": "BUYRESULT",
      "direction": "server",
      "fields": []
    },
    "23": {
      "name": "HATCHPET",
      "direction": "server",
      "fields": []
    },
    "24": {
      "name": "ACTIVEPETPDATEREQ",
      "direction": "client",
      "fields": [
        {
          "name": "commandId",
          "type": "byte"
        },
        {
          "name": "petId",
          "type": "uint32"
        }
      ],
      "note": "Same wire as EK ActivePetUpdateRequest."
    },
    "25": {
      "name": "ENEMYHIT",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "ownerId",
          "type": "int32"
        },
        {
          "name": "targetId",
          "type": "int32"
        },
        {
          "name": "kill",
          "type": "bool"
        },
        {
          "name": "unknownId",
          "type": "int32"
        }
      ]
    },
    "26": {
      "name": "GUILDRESULT",
      "direction": "server",
      "fields": []
    },
    "27": {
      "name": "EDITACCOUNTLIST",
      "direction": "client",
      "fields": []
    },
    "28": {
      "name": "TRADECHANGED",
      "direction": "server",
      "fields": [
        {
          "name": "offer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        }
      ]
    },
    "30": {
      "name": "PLAYERSHOOT",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "shotId",
          "type": "uint16"
        },
        {
          "name": "containerType",
          "type": "int16"
        },
        {
          "name": "attackIndex",
          "type": "sbyte"
        },
        {
          "name": "projectilePosition",
          "type": "Location"
        },
        {
          "name": "angle",
          "type": "float"
        },
        {
          "name": "bulletId",
          "type": "byte"
        },
        {
          "name": "unknownShort",
          "type": "int16"
        },
        {
          "name": "playerPosition",
          "type": "Location"
        }
      ]
    },
    "31": {
      "name": "PONG",
      "direction": "client",
      "fields": [
        {
          "name": "serial",
          "type": "int32"
        },
        {
          "name": "time",
          "type": "int32"
        }
      ]
    },
    "33": {
      "name": "CHANGEPETSKIN",
      "direction": "client",
      "fields": []
    },
    "34": {
      "name": "TRADEDONE",
      "direction": "server",
      "fields": [
        {
          "name": "code",
          "type": "int32"
        },
        {
          "name": "description",
          "type": "string"
        }
      ]
    },
    "35": {
      "name": "ENEMYSHOOT",
      "direction": "server",
      "fields": [
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "ownerId",
          "type": "int32"
        },
        {
          "name": "bulletType",
          "type": "byte"
        },
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "angle",
          "type": "float"
        },
        {
          "name": "damage",
          "type": "int16"
        },
        {
          "name": "numShots",
          "type": "byte",
          "optional": true,
          "default": 255
        },
        {
          "name": "angleInc",
          "type": "float",
          "optional": true,
          "default": 0
        }
      ]
    },
    "36": {
      "name": "ACCEPTTRADE",
      "direction": "client",
      "fields": [
        {
          "name": "clientOffer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        },
        {
          "name": "partnerOffer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        }
      ]
    },
    "37": {
      "name": "CHANGEGUILDRANK",
      "direction": "client",
      "fields": []
    },
    "38": {
      "name": "PLAYSOUND",
      "direction": "server",
      "fields": []
    },
    "39": {
      "name": "VERIFYEMAIL",
      "direction": "server",
      "fields": []
    },
    "40": {
      "name": "SQUAREHIT",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "objectId",
          "type": "int32"
        }
      ]
    },
    "41": {
      "name": "NEWABILITYMESSAGE",
      "direction": "server",
      "fields": [
        {
          "name": "abilityType",
          "type": "int32"
        }
      ]
    },
    "42": {
      "name": "UPDATE",
      "direction": "server",
      "fields": [
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "levelType",
          "type": "byte"
        },
        {
          "name": "tiles",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "Tile"
        },
        {
          "name": "newObjs",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "Entity"
        },
        {
          "name": "drops",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        }
      ]
    },
    "44": {
      "name": "TEXT",
      "direction": "server",
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "numStars",
          "type": "int16"
        },
        {
          "name": "bubbleTime",
          "type": "byte"
        },
        {
          "name": "recipient",
          "type": "string"
        },
        {
          "name": "text",
          "type": "string"
        },
        {
          "name": "cleanText",
          "type": "string"
        },
        {
          "name": "isSupporter",
          "type": "bool"
        },
        {
          "name": "starBg",
          "type": "int32"
        }
      ]
    },
    "45": {
      "name": "RECONNECT",
      "direction": "server",
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "host",
          "type": "string"
        },
        {
          "name": "port",
          "type": "uint16"
        },
        {
          "name": "gameId",
          "type": "int32"
        },
        {
          "name": "keyTime",
          "type": "int32"
        },
        {
          "name": "key",
          "type": "byteArray16"
        }
      ]
    },
    "46": {
      "name": "DEATH",
      "direction": "server",
      "fields": [
        {
          "name": "accountId",
          "type": "string"
        },
        {
          "name": "charId",
          "type": "compressedInt"
        },
        {
          "name": "killedBy",
          "type": "string"
        },
        {
          "name": "unknownInt",
          "type": "int32"
        },
        {
          "name": "fameEarned",
          "type": "compressedInt"
        },
        {
          "name": "accountLevel",
          "type": "compressedInt"
        },
        {
          "name": "accountXP",
          "type": "compressedInt"
        }
      ],
      "note": "Partial definition — fameBonuses and pcStats have complex encoding. Remaining bytes pass through as unreadData."
    },
    "47": {
      "name": "USEPORTAL",
      "direction": "client",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        }
      ]
    },
    "48": {
      "name": "GOTOQUESTROOM",
      "direction": "client",
      "fields": []
    },
    "49": {
      "name": "ALLYSHOOT",
      "direction": "server",
      "fields": [
        {
          "name": "unknownByte",
          "type": "byte"
        },
        {
          "name": "unknownShort",
          "type": "int16"
        }
      ]
    },
    "50": {
      "name": "IMMINENTARENAWAVE",
      "direction": "server",
      "fields": []
    },
    "51": {
      "name": "RESKIN",
      "direction": "client",
      "fields": []
    },
    "52": {
      "name": "RESETDAILYQUESTS",
      "direction": "client",
      "fields": []
    },
    "53": {
      "name": "PETCHANGEFORMMSG",
      "direction": "server",
      "fields": []
    },
    "55": {
      "name": "INVENTORYSWAP",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "slotObject1",
          "type": "SlotObject"
        },
        {
          "name": "slotObject2",
          "type": "SlotObject"
        },
        {
          "name": "tickId",
          "type": "int32",
          "optional": true,
          "default": 0
        }
      ]
    },
    "56": {
      "name": "CHANGETRADE",
      "direction": "client",
      "fields": [
        {
          "name": "offer",
          "type": "array",
          "lengthType": "int16",
          "elementType": "bool"
        }
      ]
    },
    "57": {
      "name": "CREATE",
      "direction": "client",
      "fields": [
        {
          "name": "classType",
          "type": "int16"
        },
        {
          "name": "skinType",
          "type": "int16"
        },
        {
          "name": "isChallenger",
          "type": "bool"
        },
        {
          "name": "isSeasonal",
          "type": "bool"
        }
      ]
    },
    "58": {
      "name": "QUESTREDEEM",
      "direction": "client",
      "fields": []
    },
    "59": {
      "name": "CREATEGUILD",
      "direction": "client",
      "fields": []
    },
    "60": {
      "name": "SETCONDITION",
      "direction": "client",
      "fields": [
        {
          "name": "conditionEffect",
          "type": "byte"
        },
        {
          "name": "conditionDuration",
          "type": "float"
        }
      ]
    },
    "61": {
      "name": "LOAD",
      "direction": "client",
      "fields": [
        {
          "name": "charId",
          "type": "int32"
        },
        {
          "name": "isFromArena",
          "type": "bool"
        }
      ]
    },
    "62": {
      "name": "MOVE",
      "direction": "client",
      "fields": [
        {
          "name": "tickId",
          "type": "int32"
        },
        {
          "name": "serverRealTimeMSofLastNewTick",
          "type": "uint32"
        },
        {
          "name": "records",
          "type": "array",
          "lengthType": "int16",
          "elementType": "LocationRecord"
        }
      ]
    },
    "63": {
      "name": "KEYINFORESPONSE",
      "direction": "server",
      "fields": []
    },
    "64": {
      "name": "AOE",
      "direction": "server",
      "fields": [
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "radius",
          "type": "float"
        },
        {
          "name": "damage",
          "type": "uint16"
        },
        {
          "name": "effect",
          "type": "byte"
        },
        {
          "name": "effectDuration",
          "type": "float"
        },
        {
          "name": "originType",
          "type": "uint16"
        },
        {
          "name": "color",
          "type": "int32"
        },
        {
          "name": "armorPierce",
          "type": "bool"
        }
      ]
    },
    "65": {
      "name": "GOTOACK",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "unknownByte",
          "type": "byte"
        }
      ]
    },
    "66": {
      "name": "GLOBALNOTIFICATION",
      "direction": "server",
      "fields": [
        {
          "name": "notificationType",
          "type": "int32"
        },
        {
          "name": "text",
          "type": "string"
        }
      ]
    },
    "67": {
      "name": "NOTIFICATION",
      "direction": "server",
      "fields": [
        {
          "name": "typeValue",
          "type": "byte"
        },
        {
          "name": "textByte",
          "type": "byte"
        }
      ],
      "note": "Complex conditional packet - extra fields depend on typeValue. Remaining bytes stored in unreadData for passthrough."
    },
    "68": {
      "name": "ARENADEATH",
      "direction": "server",
      "fields": []
    },
    "69": {
      "name": "CLIENTSTAT",
      "direction": "server",
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "value",
          "type": "int32"
        }
      ]
    },
    "74": {
      "name": "HELLO",
      "direction": "client",
      "fields": [
        {
          "name": "gameId",
          "type": "int32"
        },
        {
          "name": "buildVersion",
          "type": "string"
        },
        {
          "name": "accessToken",
          "type": "string"
        },
        {
          "name": "keyTime",
          "type": "int32"
        },
        {
          "name": "key",
          "type": "byteArray16"
        },
        {
          "name": "gameNet",
          "type": "string"
        },
        {
          "name": "playPlatform",
          "type": "string"
        },
        {
          "name": "platformToken",
          "type": "string"
        },
        {
          "name": "userToken",
          "type": "string"
        },
        {
          "name": "clientIdentification",
          "type": "string"
        }
      ]
    },
    "75": {
      "name": "DAMAGE",
      "direction": "server",
      "fields": [
        {
          "name": "targetId",
          "type": "int32"
        },
        {
          "name": "effects",
          "type": "array",
          "lengthType": "byte",
          "elementType": "byte"
        },
        {
          "name": "damageAmount",
          "type": "uint16"
        },
        {
          "name": "kill",
          "type": "bool"
        },
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "objectId",
          "type": "int32"
        }
      ]
    },
    "76": {
      "name": "ACTIVEPET",
      "direction": "server",
      "fields": []
    },
    "77": {
      "name": "INVITEDTOGUILD",
      "direction": "server",
      "fields": []
    },
    "78": {
      "name": "PETYARDUPDATE",
      "direction": "server",
      "fields": []
    },
    "79": {
      "name": "PASSWORDPROMPT",
      "direction": "server",
      "fields": []
    },
    "80": {
      "name": "ACCEPTARENADEATH",
      "direction": "server",
      "fields": []
    },
    "81": {
      "name": "UPDATEACK",
      "direction": "client",
      "fields": []
    },
    "82": {
      "name": "QUESTOBJECTID",
      "direction": "server",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        }
      ]
    },
    "83": {
      "name": "PIC",
      "direction": "server",
      "fields": []
    },
    "84": {
      "name": "REALMHEROESRESPONSE",
      "direction": "server",
      "fields": [
        {
          "name": "numberOfRealmHeros",
          "type": "int32"
        }
      ]
    },
    "85": {
      "name": "BUY",
      "direction": "client",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "quantity",
          "type": "int32"
        }
      ]
    },
    "86": {
      "name": "TRADESTART",
      "direction": "server",
      "fields": [
        {
          "name": "clientItems",
          "type": "array",
          "lengthType": "int16",
          "elementType": "TradeItem"
        },
        {
          "name": "partnerName",
          "type": "string"
        },
        {
          "name": "partnerItems",
          "type": "array",
          "lengthType": "int16",
          "elementType": "TradeItem"
        }
      ]
    },
    "87": {
      "name": "EVOLVEPET",
      "direction": "server",
      "fields": []
    },
    "88": {
      "name": "TRADEREQUESTED",
      "direction": "server",
      "fields": [
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    "89": {
      "name": "AOEACK",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "position",
          "type": "Location"
        }
      ]
    },
    "90": {
      "name": "PLAYERHIT",
      "direction": "client",
      "fields": [
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "objectId",
          "type": "int32"
        }
      ]
    },
    "91": {
      "name": "CANCELTRADE",
      "direction": "client",
      "fields": []
    },
    "92": {
      "name": "MAPINFO",
      "direction": "server",
      "fields": [
        {
          "name": "width",
          "type": "int32"
        },
        {
          "name": "height",
          "type": "int32"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "displayName",
          "type": "string"
        },
        {
          "name": "realmName",
          "type": "string"
        },
        {
          "name": "fp",
          "type": "int32"
        },
        {
          "name": "background",
          "type": "int32"
        },
        {
          "name": "difficulty",
          "type": "float"
        },
        {
          "name": "allowPlayerTeleport",
          "type": "bool"
        },
        {
          "name": "noSave",
          "type": "bool"
        },
        {
          "name": "showDisplays",
          "type": "bool"
        },
        {
          "name": "maxPlayers",
          "type": "int16"
        },
        {
          "name": "gameOpenedTime",
          "type": "int32"
        },
        {
          "name": "serverVersion",
          "type": "string"
        },
        {
          "name": "viewDistance",
          "type": "int16"
        },
        {
          "name": "bgColor",
          "type": "int32",
          "optional": true,
          "default": 0
        },
        {
          "name": "modifier",
          "type": "string",
          "optional": true,
          "default": ""
        },
        {
          "name": "unknownShort1",
          "type": "int16",
          "optional": true,
          "default": 0
        },
        {
          "name": "unknownBool",
          "type": "bool",
          "optional": true,
          "default": false
        },
        {
          "name": "unknownShort2",
          "type": "int16",
          "optional": true,
          "default": 0
        },
        {
          "name": "maxRealmScore",
          "type": "int32",
          "optional": true,
          "default": 0
        },
        {
          "name": "currentRealmScore",
          "type": "int32",
          "optional": true,
          "default": 0
        }
      ]
    },
    "93": {
      "name": "CLAIMDAILYLOGINRESPONSE",
      "direction": "server",
      "fields": [
        {
          "name": "itemId",
          "type": "int32"
        },
        {
          "name": "quantity",
          "type": "int32"
        },
        {
          "name": "gold",
          "type": "int32"
        }
      ]
    },
    "94": {
      "name": "KEYINFOREQUEST",
      "direction": "client",
      "fields": []
    },
    "95": {
      "name": "INVRESULT",
      "direction": "server",
      "fields": [
        {
          "name": "unknownBool",
          "type": "bool"
        },
        {
          "name": "unknownByte",
          "type": "sbyte"
        },
        {
          "name": "fromSlot",
          "type": "SlotObject"
        },
        {
          "name": "toSlot",
          "type": "SlotObject"
        },
        {
          "name": "unknownInt1",
          "type": "int32"
        },
        {
          "name": "unknownInt2",
          "type": "int32"
        }
      ]
    },
    "96": {
      "name": "QUESTREDEEMRESPONSE",
      "direction": "server",
      "fields": []
    },
    "97": {
      "name": "CHOOSENAME",
      "direction": "client",
      "fields": []
    },
    "98": {
      "name": "QUESTFETCHASK",
      "direction": "client",
      "fields": []
    },
    "99": {
      "name": "ACCOUNTLIST",
      "direction": "server",
      "fields": []
    },
    "100": {
      "name": "SHOOTACK",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        }
      ]
    },
    "101": {
      "name": "CREATESUCCESS",
      "direction": "server",
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "charId",
          "type": "int32"
        },
        {
          "name": "stats",
          "type": "string"
        }
      ]
    },
    "102": {
      "name": "CHECKCREDITS",
      "direction": "client",
      "fields": []
    },
    "103": {
      "name": "GROUNDDAMAGE",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "position",
          "type": "Location"
        }
      ]
    },
    "104": {
      "name": "GUILDINVITE",
      "direction": "client",
      "fields": []
    },
    "105": {
      "name": "ESCAPE",
      "direction": "client",
      "fields": []
    },
    "106": {
      "name": "FILE",
      "direction": "server",
      "fields": []
    },
    "107": {
      "name": "RESKINUNLOCK",
      "direction": "server",
      "fields": [
        {
          "name": "isPetSkin",
          "type": "int32"
        }
      ]
    },
    "108": {
      "name": "NEWCHARACTERINFO",
      "direction": "server",
      "fields": []
    },
    "109": {
      "name": "UNLOCKINFORMATION",
      "direction": "server",
      "fields": []
    },
    "112": {
      "name": "QUEUEMESSAGE",
      "direction": "server",
      "fields": [
        {
          "name": "curPos",
          "type": "uint16"
        },
        {
          "name": "maxPos",
          "type": "uint16"
        }
      ],
      "note": "RealmShark QUEUE_INFORMATION (112, incoming)."
    },
    "113": {
      "name": "QUEUECANCEL",
      "direction": "client",
      "fields": [
        {
          "name": "queueType",
          "type": "string"
        }
      ]
    },
    "114": {
      "name": "EXALTATIONBONUSCHANGED",
      "direction": "server",
      "fields": [
        {
          "name": "objType",
          "type": "int16"
        },
        {
          "name": "dexProgress",
          "type": "compressedInt"
        },
        {
          "name": "spdProgress",
          "type": "compressedInt"
        },
        {
          "name": "vitProgress",
          "type": "compressedInt"
        },
        {
          "name": "wisProgress",
          "type": "compressedInt"
        },
        {
          "name": "defProgress",
          "type": "compressedInt"
        },
        {
          "name": "attProgress",
          "type": "compressedInt"
        },
        {
          "name": "manaProgress",
          "type": "compressedInt"
        },
        {
          "name": "lifeProgress",
          "type": "compressedInt"
        }
      ]
    },
    "115": {
      "name": "REDEEMEXALTATIONREWARD",
      "direction": "client",
      "fields": [
        {
          "name": "itemType",
          "type": "int32"
        }
      ]
    },
    "117": {
      "name": "VAULTCONTENT",
      "direction": "server",
      "fields": [
        {
          "name": "lastVaultUpdate",
          "type": "bool"
        },
        {
          "name": "vaultChestObjectId",
          "type": "compressedInt"
        },
        {
          "name": "materialChestObjectId",
          "type": "compressedInt"
        },
        {
          "name": "giftChestObjectId",
          "type": "compressedInt"
        },
        {
          "name": "potionStorageObjectId",
          "type": "compressedInt"
        },
        {
          "name": "seasonalSpoilChestObjectId",
          "type": "compressedInt"
        },
        {
          "name": "vaultContents",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        },
        {
          "name": "materialContents",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        },
        {
          "name": "giftContents",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        },
        {
          "name": "potionContents",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        },
        {
          "name": "seasonalSpoilContent",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        },
        {
          "name": "vaultUpgradeCost",
          "type": "int16"
        },
        {
          "name": "materialUpgradeCost",
          "type": "int16"
        },
        {
          "name": "seasonalSpoilUpgradeCost",
          "type": "int16"
        },
        {
          "name": "potionUpgradeCost",
          "type": "int16"
        },
        {
          "name": "currentPotionMax",
          "type": "int16"
        },
        {
          "name": "nextPotionMax",
          "type": "int16"
        },
        {
          "name": "vaultChestEnchants",
          "type": "string"
        },
        {
          "name": "giftChestEnchants",
          "type": "string"
        },
        {
          "name": "spoilsChestEnchants",
          "type": "string"
        }
      ]
    },
    "118": {
      "name": "FORGEREQUEST",
      "direction": "client",
      "fields": []
    },
    "119": {
      "name": "FORGERESULT",
      "direction": "server",
      "fields": []
    },
    "120": {
      "name": "FORGEUNLOCKEDBLUEPRINTS",
      "direction": "server",
      "fields": [
        {
          "name": "unknownByte",
          "type": "sbyte"
        },
        {
          "name": "blueprints",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "compressedInt"
        }
      ]
    },
    "121": {
      "name": "SHOOTACKCOUNTER",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "count",
          "type": "int16"
        }
      ],
      "note": "RealmShark SHOOT_ACK (121, outgoing)."
    },
    "122": {
      "name": "SHOWALLYSHOOT",
      "direction": "client",
      "fields": [
        {
          "name": "toggle",
          "type": "int32"
        }
      ],
      "note": "RealmShark CHANGE_ALLYSHOOT (122, outgoing)."
    },
    "123": {
      "name": "GETPLAYERSLISTMESSAGE",
      "direction": "client",
      "fields": []
    },
    "124": {
      "name": "MODERATORACTIONMESSAGE",
      "direction": "client",
      "fields": []
    },
    "126": {
      "name": "CREEPMOVEMESSAGE",
      "direction": "client",
      "fields": []
    },
    "129": {
      "name": "CUSTOMMAPDELETE",
      "direction": "client",
      "fields": []
    },
    "131": {
      "name": "CUSTOMMAPLIST",
      "direction": "client",
      "fields": []
    },
    "133": {
      "name": "CREEPHIT",
      "direction": "client",
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "bulletId",
          "type": "uint16"
        },
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "targetId",
          "type": "int32"
        }
      ]
    },
    "134": {
      "name": "PLAYERCALLOUT",
      "direction": "client",
      "fields": [
        {
          "name": "calloutType",
          "type": "byte"
        },
        {
          "name": "value",
          "type": "int32"
        }
      ]
    },
    "136": {
      "name": "BUYREFINEMENT",
      "direction": "client",
      "fields": [
        {
          "name": "slot",
          "type": "SlotObject"
        },
        {
          "name": "action",
          "type": "int16"
        }
      ]
    },
    "137": {
      "name": "DASH",
      "direction": "client",
      "fields": []
    },
    "138": {
      "name": "DASHACK",
      "direction": "client",
      "fields": []
    },
    "139": {
      "name": "STATS",
      "direction": "server",
      "fields": [
        {
          "name": "charId",
          "type": "compressedInt"
        }
      ],
      "note": "RealmShark StatsPacket: charId then StatsStateData; remainder stays in unreadData until schema is extended."
    },
    "140": {
      "name": "BUYCUSTOMISATIONSOCKET",
      "direction": "client",
      "fields": []
    },
    "145": {
      "name": "FAVORPET",
      "direction": "client",
      "fields": [
        {
          "name": "petId",
          "type": "int32"
        }
      ]
    },
    "146": {
      "name": "SKINRECYCLE",
      "direction": "client",
      "fields": [
        {
          "name": "item",
          "type": "SlotObject"
        }
      ]
    },
    "147": {
      "name": "UNKNOWN147",
      "direction": "server",
      "fields": []
    },
    "148": {
      "name": "DAMAGEBOOST",
      "direction": "server",
      "fields": []
    },
    "149": {
      "name": "CLAIMBATTLEPASS",
      "direction": "client",
      "fields": [
        {
          "name": "item",
          "type": "sbyte"
        }
      ]
    },
    "150": {
      "name": "CLAIMBATTLEPASSRESPONSE",
      "direction": "server",
      "fields": [
        {
          "name": "success",
          "type": "bool"
        }
      ],
      "note": "RealmShark CLAIM_BP_MILESTONE_RESULT (150, incoming). EK ClaimBPMilestoneResult."
    },
    "151": {
      "name": "BOOSTBPMILESTONE",
      "direction": "client",
      "fields": [
        {
          "name": "milestoneIndex",
          "type": "byte"
        }
      ]
    },
    "154": {
      "name": "CONVERTSEASONALCHARACTER",
      "direction": "client",
      "fields": []
    },
    "155": {
      "name": "RETITLE",
      "direction": "client",
      "fields": [
        {
          "name": "prefix",
          "type": "int32"
        },
        {
          "name": "suffix",
          "type": "int32"
        }
      ]
    },
    "156": {
      "name": "SETGRAVESTONE",
      "direction": "client",
      "fields": []
    },
    "157": {
      "name": "SETABILITY",
      "direction": "client",
      "fields": [
        {
          "name": "abilityType",
          "type": "int32"
        },
        {
          "name": "abilityIndex",
          "type": "sbyte"
        }
      ]
    },
    "159": {
      "name": "EMOTE",
      "direction": "client",
      "fields": [
        {
          "name": "emoteId",
          "type": "int32"
        },
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "unknownBool",
          "type": "bool"
        }
      ],
      "note": "RealmShark EMOTE (159). EK Emote uses bool, not sbyte."
    },
    "160": {
      "name": "BUYEMOTE",
      "direction": "client",
      "fields": [
        {
          "name": "emoteId",
          "type": "int32"
        }
      ]
    },
    "162": {
      "name": "SETTRACKEDSEASON",
      "direction": "client",
      "fields": []
    },
    "163": {
      "name": "CLAIMMISSION",
      "direction": "client",
      "fields": [
        {
          "name": "missionId",
          "type": "int32"
        },
        {
          "name": "unknownByte1",
          "type": "byte"
        },
        {
          "name": "unknownByte2",
          "type": "byte"
        },
        {
          "name": "unknownShort",
          "type": "uint16"
        }
      ]
    },
    "164": {
      "name": "UNKNOWN164",
      "direction": "server",
      "fields": []
    },
    "165": {
      "name": "UNKNOWN165",
      "direction": "server",
      "fields": [
        {
          "name": "unknownStr",
          "type": "string"
        }
      ]
    },
    "166": {
      "name": "STASIS",
      "direction": "server",
      "fields": []
    },
    "167": {
      "name": "SETDISCOVERABLE",
      "direction": "client",
      "fields": []
    },
    "169": {
      "name": "REALMSCOREUPDATE",
      "direction": "server",
      "fields": [
        {
          "name": "score",
          "type": "int32"
        }
      ]
    },
    "170": {
      "name": "CLAIMREWARDSINFOPROMPT",
      "direction": "server",
      "fields": []
    },
    "171": {
      "name": "CLAIMCHESTREWARD",
      "direction": "server",
      "fields": []
    },
    "172": {
      "name": "CHESTREWARDRESULT",
      "direction": "server",
      "fields": []
    },
    "173": {
      "name": "UNLOCKENCHANTMENTSLOT",
      "direction": "client",
      "fields": []
    },
    "175": {
      "name": "UNLOCKENCHANTMENT",
      "direction": "client",
      "fields": []
    },
    "177": {
      "name": "APPLYENCHANTMENT",
      "direction": "client",
      "fields": []
    },
    "180": {
      "name": "ACTIVATECRUCIBLE",
      "direction": "client",
      "fields": [
        {
          "name": "crucibleId",
          "type": "string"
        },
        {
          "name": "activate",
          "type": "bool"
        }
      ]
    },
    "181": {
      "name": "UNKNOWN181",
      "direction": "server",
      "fields": []
    },
    "182": {
      "name": "CRUCIBLEREQUEST",
      "direction": "client",
      "fields": [
        {
          "name": "types",
          "type": "array",
          "lengthType": "int16",
          "elementType": "int32"
        }
      ]
    },
    "183": {
      "name": "CRUCIBLERESPONSE",
      "direction": "server",
      "fields": [
        {
          "name": "crucibleIds",
          "type": "array",
          "lengthType": "int16",
          "elementType": "int32"
        },
        {
          "name": "crucibleJsons",
          "type": "array",
          "lengthType": "int16",
          "elementType": "string"
        }
      ]
    },
    "185": {
      "name": "UPGRADEENCHANTER",
      "direction": "client",
      "fields": []
    },
    "187": {
      "name": "UPGRADEENCHANTMENT",
      "direction": "client",
      "fields": []
    },
    "189": {
      "name": "REROLLALLENCHANTMENTS",
      "direction": "client",
      "fields": []
    },
    "190": {
      "name": "UNKNOWN190",
      "direction": "server",
      "fields": []
    },
    "191": {
      "name": "RESETENCHANTMENTREROLLCOUNT",
      "direction": "client",
      "fields": []
    },
    "200": {
      "name": "CREATEPARTYMESSAGE",
      "direction": "client",
      "fields": [
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "minPowerLevel",
          "type": "int16"
        },
        {
          "name": "maxPartySize",
          "type": "sbyte"
        },
        {
          "name": "activity",
          "type": "sbyte"
        },
        {
          "name": "maxedStatReq",
          "type": "sbyte"
        },
        {
          "name": "privacy",
          "type": "sbyte"
        },
        {
          "name": "serverIndex",
          "type": "byte"
        }
      ]
    },
    "204": {
      "name": "PARTYACTIONRESULT",
      "direction": "client",
      "fields": [
        {
          "name": "playerId",
          "type": "uint16"
        },
        {
          "name": "actionId",
          "type": "byte"
        }
      ],
      "note": "C→S (EK PartyActionResult). playerId 0xFFFF often self; actionId drives party UI (e.g. list refresh)."
    },
    "207": {
      "name": "PARTYACTION",
      "direction": "server",
      "fields": [
        {
          "name": "playerId",
          "type": "uint16"
        },
        {
          "name": "actionId",
          "type": "byte"
        }
      ],
      "note": "S→C (EK PartyAction). Server echo / result for party actions."
    },
    "208": {
      "name": "INCOMINGPARTYINVITE",
      "direction": "server",
      "fields": [
        {
          "name": "partyId",
          "type": "uint32"
        },
        {
          "name": "inviterName",
          "type": "string"
        }
      ]
    },
    "209": {
      "name": "PARTYINVITERESPONSE",
      "direction": "client",
      "fields": [
        {
          "name": "partyId",
          "type": "uint32"
        },
        {
          "name": "accept",
          "type": "byte"
        }
      ]
    },
    "210": {
      "name": "INCOMINGPARTYMEMBERINFO",
      "direction": "server",
      "fields": [
        {
          "name": "partyId",
          "type": "uint32"
        },
        {
          "name": "unknownShort",
          "type": "uint16"
        },
        {
          "name": "maxSize",
          "type": "byte"
        },
        {
          "name": "partyPlayers",
          "type": "array",
          "lengthType": "int16",
          "elementType": "PartyPlayer"
        },
        {
          "name": "description",
          "type": "string"
        }
      ],
      "note": "EK IncomingPartyMemberInfo.Read order; PartyPlayer matches EK PartyPlayer."
    },
    "212": {
      "name": "PARTYMEMBERADDED",
      "direction": "server",
      "fields": [
        {
          "name": "playerId",
          "type": "uint16"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "classId",
          "type": "uint16"
        },
        {
          "name": "skinId",
          "type": "uint16"
        }
      ]
    },
    "214": {
      "name": "PARTYLISTMESSAGE",
      "direction": "server",
      "fields": [
        {
          "name": "packetNumber",
          "type": "byte"
        },
        {
          "name": "parties",
          "type": "array",
          "lengthType": "int16",
          "elementType": "PartyInfo"
        }
      ],
      "note": "EK PartyList; activity/privacy are bytes (PartyActivity, PartyPrivacy enums)."
    },
    "215": {
      "name": "PARTYJOINREQUEST",
      "direction": "client",
      "fields": [
        {
          "name": "partyId",
          "type": "uint32"
        },
        {
          "name": "unknownByte",
          "type": "byte"
        }
      ],
      "note": "C→S: client requests to join a party (partyId + byte; matches EK PartyJoinRequest)."
    },
    "217": {
      "name": "PARTYJOINREQUESTRESPONSE",
      "direction": "server",
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "classId",
          "type": "uint16"
        },
        {
          "name": "skinId",
          "type": "uint16"
        },
        {
          "name": "state",
          "type": "byte"
        }
      ]
    },
    "218": {
      "name": "FORRECONNECT",
      "direction": "server",
      "fields": []
    },
    "222": {
      "name": "LOADINGSCREEN",
      "direction": "server",
      "fields": []
    }
  },
  "dataObjects": {
    "FameData": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "rank",
          "type": "compressedInt"
        },
        {
          "name": "fame",
          "type": "compressedInt"
        }
      ]
    },
    "Location": {
      "fields": [
        {
          "name": "x",
          "type": "float"
        },
        {
          "name": "y",
          "type": "float"
        }
      ]
    },
    "LocationRecord": {
      "fields": [
        {
          "name": "time",
          "type": "int32"
        },
        {
          "name": "x",
          "type": "float"
        },
        {
          "name": "y",
          "type": "float"
        }
      ]
    },
    "Tile": {
      "fields": [
        {
          "name": "x",
          "type": "int16"
        },
        {
          "name": "y",
          "type": "int16"
        },
        {
          "name": "type",
          "type": "uint16"
        }
      ]
    },
    "Entity": {
      "fields": [
        {
          "name": "objectType",
          "type": "uint16"
        },
        {
          "name": "status",
          "type": "Status"
        }
      ]
    },
    "Status": {
      "fields": [
        {
          "name": "objectId",
          "type": "compressedInt"
        },
        {
          "name": "position",
          "type": "Location"
        },
        {
          "name": "data",
          "type": "array",
          "lengthType": "compressedInt",
          "elementType": "StatData"
        }
      ]
    },
    "StatData": {
      "fields": [
        {
          "name": "id",
          "type": "byte"
        },
        {
          "name": "value",
          "type": "statValue"
        },
        {
          "name": "stackCount",
          "type": "compressedInt"
        }
      ]
    },
    "SlotObject": {
      "fields": [
        {
          "name": "objectId",
          "type": "int32"
        },
        {
          "name": "slotId",
          "type": "int32"
        },
        {
          "name": "objectType",
          "type": "int32"
        }
      ]
    },
    "PartyInfo": {
      "fields": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "partyId",
          "type": "uint32"
        },
        {
          "name": "powerLevelMin",
          "type": "uint16"
        },
        {
          "name": "partySizeCurrent",
          "type": "byte"
        },
        {
          "name": "partySizeMax",
          "type": "byte"
        },
        {
          "name": "activity",
          "type": "byte"
        },
        {
          "name": "privacy",
          "type": "byte"
        },
        {
          "name": "statsMin",
          "type": "byte"
        },
        {
          "name": "serverIndex",
          "type": "byte"
        }
      ]
    },
    "PartyPlayer": {
      "fields": [
        {
          "name": "playerId",
          "type": "uint16"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "classId",
          "type": "uint16"
        },
        {
          "name": "skinId",
          "type": "uint16"
        }
      ]
    },
    "QuestData": {
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "expiration",
          "type": "string"
        },
        {
          "name": "category",
          "type": "int32"
        },
        {
          "name": "type",
          "type": "int32"
        },
        {
          "name": "itemsNeeded",
          "type": "array",
          "lengthType": "int16",
          "elementType": "int32"
        },
        {
          "name": "rewards",
          "type": "array",
          "lengthType": "int16",
          "elementType": "int32"
        },
        {
          "name": "completed",
          "type": "bool"
        },
        {
          "name": "choice",
          "type": "bool"
        },
        {
          "name": "repeatable",
          "type": "bool"
        }
      ]
    },
    "TradeItem": {
      "fields": [
        {
          "name": "item",
          "type": "int32"
        },
        {
          "name": "slotType",
          "type": "int32"
        },
        {
          "name": "tradeable",
          "type": "bool"
        },
        {
          "name": "included",
          "type": "bool"
        },
        {
          "name": "enchantment",
          "type": "string"
        }
      ]
    }
  }
};

export default packetDefinitions;
